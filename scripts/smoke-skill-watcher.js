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
 *   1. dist/skills/watcher.js loads, loads a .skill.md file that was there
 *      before start(), and reports a .skill.md file that is added, edited
 *      and deleted.
 *   2. The watcher evaluates no code file. .js and .ts files that are added,
 *      edited and deleted in the watched directory, with `patterns` that
 *      name them, leave no marker and no event, and a code skill that was
 *      registered from one of them stays registered.
 *   3. A .skill.md file that declares the name of that code skill does not
 *      replace it, and deleting the file leaves the code skill registered.
 *
 * Exit code 1 means one of these failed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 15000;
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

function writeJavaScriptSkill(file, name, output, firstLine = '') {
  const source = `module.exports = ${skillSource(name, output)};\n`;
  fs.writeFileSync(file, `'use strict';\n${firstLine}\n${source}`);
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
      writeJavaScriptSkill(path.join(dir, name), `from-${name}`, output, leaveMarker);
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
    (name) => name !== 'sentinel' && name !== 'present-before-start'
  );
  if (fromCode.length > 0 || !registry.has('code-skill')) {
    throw new Error(
      `the watcher acted on a code file: events for ${fromCode}, ` +
        `code-skill registered: ${registry.has('code-skill')}`
    );
  }
}

/**
 * A .skill.md file that declares the name of the registered code skill is
 * refused, and deleting it leaves the code skill registered. The load of a
 * later .skill.md file shows that the watcher has handled the delete.
 */
async function checkMarkdownCannotTakeACodeSkillName(dir, seen, registry) {
  const codePath = registry.getFile('code-skill').path;
  const file = path.join(dir, 'collide.skill.md');
  fs.writeFileSync(file, '---\nname: code-skill\ntriggers: [code]\n---\nmarkdown\n');
  const refused = () => seen.errors.some((e) => e.error.message.includes('"code-skill"'));
  await waitFor(refused, "an 'error' for collide.skill.md");
  fs.rmSync(file);
  writeMarkdownSkill(dir, 'after-collide');
  await waitFor(() => seen.loaded.includes('after-collide'), "'loaded' for after-collide");

  const owner = registry.getFile('code-skill');
  if (owner?.path !== codePath || seen.unloaded.includes('code-skill')) {
    throw new Error(`code-skill was replaced or unloaded by collide.skill.md: now ${owner?.path}`);
  }
}

async function main() {
  const { SkillWatcher } = require('../dist/skills/watcher.js');
  const { getSkillRegistry } = require('../dist/skills/registry.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-watcher-smoke-'));
  const dir = path.join(root, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  writeMarkdownSkill(dir, 'present-before-start');
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
    await waitFor(
      () => seen.loaded.includes('present-before-start'),
      "'loaded' for the file that was there before start()"
    );
    await checkCodeFilesAreLeftAlone(dir, path.join(root, 'markers'), seen, registry);
    if (seen.errors.length > 0) {
      throw new Error(`unexpected watcher errors: ${seen.errors.map((e) => e.error.message)}`);
    }
    await checkMarkdownCannotTakeACodeSkillName(dir, seen, registry);
    console.log(
      `skill watcher smoke ok: node ${process.version}, ` +
        'a .skill.md file present before start() was loaded, ' +
        'a .skill.md file was loaded, reloaded and unloaded, ' +
        'no .js or .ts file was evaluated or acted on by the watcher, ' +
        'a .skill.md file could not take the name of a code skill'
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
