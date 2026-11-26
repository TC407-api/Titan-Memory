#!/usr/bin/env node

/**
 * Smoke test for the built skill watcher and loader. CI runs it after
 * `npm run build`.
 *
 * The Jest suites compile chokidar (ES modules only since 5.0) to CommonJS
 * and cannot run import() of a JavaScript file. So they do not show whether
 * the CommonJS build in dist/ can load the real chokidar with require(),
 * whether file events arrive, or what really happens to a JavaScript file.
 * This script checks these with plain Node:
 *
 *   1. dist/skills/watcher.js loads and reports a .skill.md file that is
 *      added, edited and deleted.
 *   2. The watcher evaluates no code file. .js and .ts files that are added,
 *      edited and deleted in the watched directory, with `patterns` that
 *      name them, leave no marker and no event, and a code skill that was
 *      registered from one of them stays registered.
 *   3. reloadSkill() of a compiled JavaScript skill runs the edited code, in
 *      both export styles (`exports.default = skill`, `module.exports = skill`).
 *
 * Exit code 1 means one of these failed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 15000;
const RETRY_MS = 1000;
const POLL_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll until `check` is true. False when it is still not true after `timeoutMs`.
async function becomesTrue(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(POLL_MS);
  }
  return check();
}

async function waitFor(check, what) {
  if (!(await becomesTrue(check, TIMEOUT_MS))) {
    throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${what}`);
  }
}

function writeMarkdownSkill(dir, name, body = 'body') {
  const file = path.join(dir, `${name}.skill.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ntriggers: [${name}]\n---\n${body}\n`);
  return file;
}

// Source text of a skill object.
function skillSource(name, output) {
  return (
    `{ metadata: { name: '${name}', version: '1.0.0', description: 'smoke', ` +
    `triggers: ['${name}'] }, execute: async () => ({ success: true, output: '${output}' }) }`
  );
}

function writeJavaScriptSkill(file, name, output, exportStyle, firstLine = '') {
  const skill = skillSource(name, output);
  const source =
    exportStyle === 'default-export'
      ? `Object.defineProperty(exports, '__esModule', { value: true });\nexports.default = ${skill};\n`
      : `module.exports = ${skill};\n`;
  fs.writeFileSync(file, `'use strict';\n${firstLine}\n${source}`);
}

// Files that exist before the first scan ends are not reported, so keep
// adding new ones until the watcher reports one.
async function waitUntilLive(dir, seen) {
  const deadline = Date.now() + TIMEOUT_MS;
  const findHit = () => seen.loaded.find((name) => name.startsWith('smoke-'));
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    writeMarkdownSkill(dir, `smoke-${attempt}`);
    if (await becomesTrue(() => findHit() !== undefined, RETRY_MS)) return findHit();
  }
  throw new Error(`the watcher reported no 'loaded' event within ${TIMEOUT_MS} ms`);
}

// A code skill as something other than the watcher would have registered it.
function registerCodeSkill(registry, file) {
  const metadata = { name: 'code-skill', version: '1.0.0', description: 'smoke', triggers: ['code'] };
  registry.register({
    path: file,
    metadata,
    skill: { metadata, execute: async () => ({ success: true }) },
    loadedAt: new Date(),
    lastModified: new Date(),
    enabled: true,
  });
}

/**
 * Add, edit and delete code files next to a .skill.md file. The events of
 * the .skill.md file show that the watcher has handled each round.
 * Evaluating one of the code files would leave a marker file.
 */
async function checkCodeFilesAreLeftAlone(dir, markerDir, seen, registry) {
  // For a .ts file the loader would import the .js file next to it.
  const codeFiles = ['plain.js', 'named.skill.js', 'source.ts', 'source.js', 'named.skill.ts'];
  const marker = path.join(markerDir, 'evaluated');
  const leaveMarker = `require('fs').writeFileSync(${JSON.stringify(marker)}, __filename);`;
  const writeCodeFiles = (output) => {
    for (const name of codeFiles) {
      writeJavaScriptSkill(path.join(dir, name), `from-${name}`, output, 'module-exports', leaveMarker);
    }
  };
  fs.mkdirSync(markerDir, { recursive: true });
  registerCodeSkill(registry, path.join(dir, 'plain.js'));

  writeCodeFiles('first');
  const sentinel = writeMarkdownSkill(dir, 'sentinel');
  await waitFor(() => seen.loaded.includes('sentinel'), "'loaded' for sentinel");
  writeCodeFiles('second, edited');
  writeMarkdownSkill(dir, 'sentinel', 'a longer body than before');
  await waitFor(() => seen.reloaded.includes('sentinel'), "'reloaded' for sentinel");
  for (const name of codeFiles) fs.rmSync(path.join(dir, name));
  fs.rmSync(sentinel);
  await waitFor(() => seen.unloaded.includes('sentinel'), "'unloaded' for sentinel");

  if (fs.existsSync(marker)) {
    throw new Error(`the watcher evaluated a code file: ${fs.readFileSync(marker, 'utf-8')}`);
  }
  const fromCode = [...seen.loaded, ...seen.reloaded, ...seen.unloaded].filter(
    (name) => name !== 'sentinel' && !name.startsWith('smoke-')
  );
  if (fromCode.length > 0 || !registry.has('code-skill')) {
    throw new Error(
      `the watcher acted on a code file: events for ${fromCode}, ` +
        `code-skill registered: ${registry.has('code-skill')}`
    );
  }
}

async function checkReloadRunsEditedCode(dir, registry, reloadSkill, exportStyle) {
  const name = `compiled-${exportStyle}`;
  const file = path.join(dir, `${name}.js`);
  const run = async () => (await registry.getFile(name).skill.execute({})).output;
  fs.mkdirSync(dir, { recursive: true });

  writeJavaScriptSkill(file, name, 'first version', exportStyle);
  await reloadSkill(file);
  const before = await run();
  writeJavaScriptSkill(file, name, 'second version, edited', exportStyle);
  await reloadSkill(file);
  const after = await run();

  if (before !== 'first version' || after !== 'second version, edited') {
    throw new Error(`${name}: expected the edited code to run, got "${before}" then "${after}"`);
  }
}

async function main() {
  const { SkillWatcher } = require('../dist/skills/watcher.js');
  const { getSkillRegistry } = require('../dist/skills/registry.js');
  const { reloadSkill } = require('../dist/skills/loader.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-watcher-smoke-'));
  const dir = path.join(root, 'skills');
  const watcher = new SkillWatcher({
    skillsDir: dir,
    debounceMs: 20,
    patterns: ['**/*.js', '**/*.ts', '**/*.skill.md'],
  });
  const seen = { loaded: [], reloaded: [], unloaded: [], errors: [] };
  watcher.on('loaded', (name) => seen.loaded.push(name));
  watcher.on('reloaded', (name) => seen.reloaded.push(name));
  watcher.on('unloaded', (name) => seen.unloaded.push(name));
  watcher.on('error', (name, file, error) => seen.errors.push({ name, file, error }));

  watcher.start();
  try {
    const registry = getSkillRegistry();
    const first = await waitUntilLive(dir, seen);
    await checkCodeFilesAreLeftAlone(dir, path.join(root, 'markers'), seen, registry);
    if (seen.errors.length > 0) {
      throw new Error(`unexpected watcher errors: ${seen.errors.map((e) => e.error.message)}`);
    }
    const direct = path.join(root, 'direct');
    await checkReloadRunsEditedCode(direct, registry, reloadSkill, 'default-export');
    await checkReloadRunsEditedCode(direct, registry, reloadSkill, 'module-exports');
    console.log(
      `skill watcher smoke ok: node ${process.version}, loaded "${first}", ` +
        'a .skill.md file was loaded, reloaded and unloaded, ' +
        'no .js or .ts file was evaluated or acted on by the watcher, ' +
        'reloadSkill() ran edited JavaScript (default export and module.exports)'
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
