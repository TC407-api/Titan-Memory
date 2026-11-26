#!/usr/bin/env node

/**
 * Smoke test for the built skill watcher. CI runs it after `npm run build`.
 *
 * The Jest suites compile chokidar (ES modules only since 5.0) to CommonJS
 * and cannot run the loader's import() of a JavaScript skill. So they do not
 * show whether the CommonJS build in dist/ can load the real chokidar with
 * require(), whether file events arrive, or whether an edited JavaScript
 * skill is really loaded again. This script checks these with plain Node:
 *
 *   1. dist/skills/watcher.js loads and reports a new .skill.md file.
 *   2. A compiled JavaScript skill is loaded, in both export styles
 *      (`exports.default = skill` and `module.exports = skill`).
 *   3. After the file is edited, the registered skill runs the new code.
 *   4. A skill whose file is deleted while its onLoad() is still running
 *      ends up unloaded.
 *   5. For a .ts file, a compiled file that is behind a link (a linked dist
 *      directory, a linked sibling .js file) is never evaluated.
 *
 * Exit code 1 means one of these failed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 15000;
const RETRY_MS = 1000;
const POLL_MS = 25;
const ON_LOAD_MS = 1500;
// Longer than awaitWriteFinish (200 ms stable + 100 ms poll) plus the debounce.
const SETTLE_MS = 1200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(POLL_MS);
  }
  throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${what}`);
}

function writeMarkdownSkill(dir, name) {
  const content = `---\nname: ${name}\ntriggers: [${name}]\n---\nbody\n`;
  fs.writeFileSync(path.join(dir, `${name}.skill.md`), content);
}

// Source text of a skill object. `extra` is put in front of the closing brace.
function skillSource(name, output, extra = '') {
  return (
    `{ metadata: { name: '${name}', version: '1.0.0', description: 'smoke', ` +
    `triggers: ['${name}'] }, execute: async () => ({ success: true, output: '${output}' })${extra} }`
  );
}

function writeJavaScriptSkill(dir, name, output, exportStyle) {
  const skill = skillSource(name, output);
  const source =
    exportStyle === 'default-export'
      ? `Object.defineProperty(exports, '__esModule', { value: true });\nexports.default = ${skill};\n`
      : `module.exports = ${skill};\n`;
  fs.writeFileSync(path.join(dir, `${name}.js`), `'use strict';\n${source}`);
}

// Files that exist before the first scan ends are not reported, so keep
// adding new ones until the watcher reports one.
async function waitUntilLive(dir, seen) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    writeMarkdownSkill(dir, `smoke-${attempt}`);
    await sleep(RETRY_MS);
    const hit = seen.loaded.find((name) => name.startsWith('smoke-'));
    if (hit) return hit;
  }
  throw new Error(`the watcher reported no 'loaded' event within ${TIMEOUT_MS} ms`);
}

async function runSkill(registry, name) {
  const result = await registry.getFile(name).skill.execute({});
  return result.output;
}

async function checkJavaScriptSkillReload(dir, seen, registry, exportStyle) {
  const name = `compiled-${exportStyle}`;
  writeJavaScriptSkill(dir, name, 'first version', exportStyle);
  await waitFor(() => seen.loaded.includes(name), `'loaded' for ${name}`);
  const before = await runSkill(registry, name);

  writeJavaScriptSkill(dir, name, 'second version, edited', exportStyle);
  await waitFor(() => seen.reloaded.includes(name), `'reloaded' for ${name}`);
  const after = await runSkill(registry, name);

  if (before !== 'first version' || after !== 'second version, edited') {
    throw new Error(`${name}: expected the edited code to run, got "${before}" then "${after}"`);
  }
}

async function checkDeleteDuringOnLoad(dir, seen, registry) {
  const name = 'slow-on-load';
  const file = path.join(dir, `${name}.js`);
  const onLoad =
    `, onLoad: () => new Promise((resolve) => { ` +
    `globalThis.titanSmokeOnLoadStarted = true; setTimeout(resolve, ${ON_LOAD_MS}); })`;
  fs.writeFileSync(file, `'use strict';\nmodule.exports = ${skillSource(name, 'slow', onLoad)};\n`);

  await waitFor(() => globalThis.titanSmokeOnLoadStarted === true, `onLoad() of ${name} to start`);
  fs.rmSync(file);
  await waitFor(() => seen.loaded.includes(name), `'loaded' for ${name}`);
  await sleep(SETTLE_MS);

  if (registry.has(name) || !seen.unloaded.includes(name)) {
    throw new Error(`${name}: its file was deleted during onLoad(), but the skill is still registered`);
  }
}

// Returns false when this platform refuses to create the link.
function tryLink(target, linkPath, kind) {
  try {
    fs.symlinkSync(target, linkPath, kind === 'dir' ? 'junction' : 'file');
    return true;
  } catch (error) {
    // Windows without Developer Mode refuses file links. Directory links
    // (junctions) work there, so the dist case below always runs.
    if (process.platform === 'win32' && kind === 'file' && error.code === 'EPERM') return false;
    throw error;
  }
}

// A compiled file outside the skills directory. Evaluating it leaves a marker file.
function writeOutsideSkill(outsideDir, fileName, name) {
  const marker = path.join(outsideDir, `${name}.evaluated`);
  const leaveMarker = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'evaluated');`;
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(
    path.join(outsideDir, fileName),
    `'use strict';\n${leaveMarker}\nmodule.exports = ${skillSource(name, 'outside')};\n`
  );
  return marker;
}

async function checkLinkedCompiledFilesAreRefused(dir, outside, seen, registry) {
  const cases = [];

  // <dir>/project/src/skills/in-dist.ts, with <dir>/project/dist a link.
  const project = path.join(dir, 'project');
  const distSource = path.join(project, 'src', 'skills', 'in-dist.ts');
  const distMarker = writeOutsideSkill(path.join(outside, 'dist', 'skills'), 'in-dist.js', 'in-dist');
  fs.mkdirSync(path.dirname(distSource), { recursive: true });
  tryLink(path.join(outside, 'dist'), path.join(project, 'dist'), 'dir');
  cases.push({ name: 'in-dist', source: distSource, marker: distMarker });

  // <dir>/sibling.ts, with <dir>/sibling.js a link.
  const siblingMarker = writeOutsideSkill(path.join(outside, 'files'), 'sibling.js', 'sibling');
  if (tryLink(path.join(outside, 'files', 'sibling.js'), path.join(dir, 'sibling.js'), 'file')) {
    cases.push({ name: 'sibling', source: path.join(dir, 'sibling.ts'), marker: siblingMarker });
  }

  await sleep(SETTLE_MS);
  for (const { source } of cases) fs.writeFileSync(source, 'export {};\n');
  const isRefused = ({ source }) => seen.errors.some((error) => error.file === source);
  const wasEvaluated = ({ name, marker }) => fs.existsSync(marker) || registry.has(name);
  await waitFor(
    () => cases.every((entry) => isRefused(entry) || wasEvaluated(entry)),
    'the watcher to handle the .ts files with a linked compiled file'
  );
  await sleep(SETTLE_MS);

  const evaluated = cases.filter(wasEvaluated).map((entry) => entry.name);
  if (evaluated.length > 0) {
    throw new Error(`code outside the skills directory was loaded through a link: ${evaluated}`);
  }
  return cases.map((entry) => entry.name).join(' and ');
}

async function main() {
  const { SkillWatcher } = require('../dist/skills/watcher.js');
  const { getSkillRegistry } = require('../dist/skills/registry.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-watcher-smoke-'));
  const dir = path.join(root, 'skills');
  const watcher = new SkillWatcher({ skillsDir: dir, debounceMs: 20 });
  const seen = { loaded: [], reloaded: [], unloaded: [], errors: [] };
  watcher.on('loaded', (name) => seen.loaded.push(name));
  watcher.on('reloaded', (name) => seen.reloaded.push(name));
  watcher.on('unloaded', (name) => seen.unloaded.push(name));
  watcher.on('error', (name, file, error) => seen.errors.push({ name, file, error }));

  watcher.start();
  try {
    const registry = getSkillRegistry();
    const first = await waitUntilLive(dir, seen);
    await checkJavaScriptSkillReload(dir, seen, registry, 'default-export');
    await checkJavaScriptSkillReload(dir, seen, registry, 'module-exports');
    await checkDeleteDuringOnLoad(dir, seen, registry);
    if (seen.errors.length > 0) {
      throw new Error(`unexpected watcher errors: ${seen.errors.map((e) => e.error.message)}`);
    }
    const refused = await checkLinkedCompiledFilesAreRefused(
      dir,
      path.join(root, 'outside'),
      seen,
      registry
    );
    console.log(
      `skill watcher smoke ok: node ${process.version}, loaded "${first}", ` +
        'JavaScript skills reloaded with new code (default export and module.exports), ' +
        `a skill deleted during onLoad() was unloaded, linked compiled files refused (${refused})`
    );
  } finally {
    await watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('skill watcher smoke FAILED:', error);
    process.exit(1);
  }
);
