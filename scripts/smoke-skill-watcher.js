#!/usr/bin/env node

/**
 * Smoke test for the built skill watcher. CI runs it after `npm run build`.
 *
 * The Jest suites compile chokidar (ES modules only since 5.0) to CommonJS
 * and cannot run the loader's import() of a JavaScript skill. So they do not
 * show whether the CommonJS build in dist/ can load the real chokidar with
 * require(), whether file events arrive, or whether an edited JavaScript
 * skill is really loaded again. This script checks all three with plain Node:
 *
 *   1. dist/skills/watcher.js loads and reports a new .skill.md file.
 *   2. A compiled JavaScript skill is loaded, in both export styles
 *      (`exports.default = skill` and `module.exports = skill`).
 *   3. After the file is edited, the registered skill runs the new code.
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

function writeJavaScriptSkill(dir, name, output, exportStyle) {
  const skill =
    `{ metadata: { name: '${name}', version: '1.0.0', description: 'smoke', ` +
    `triggers: ['${name}'] }, execute: async () => ({ success: true, output: '${output}' }) }`;
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

async function main() {
  const { SkillWatcher } = require('../dist/skills/watcher.js');
  const { getSkillRegistry } = require('../dist/skills/registry.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-watcher-smoke-'));
  const watcher = new SkillWatcher({ skillsDir: dir, debounceMs: 20 });
  const seen = { loaded: [], reloaded: [] };
  watcher.on('loaded', (name) => seen.loaded.push(name));
  watcher.on('reloaded', (name) => seen.reloaded.push(name));
  watcher.on('error', (name, _file, error) => console.error('watcher error:', name, error));

  watcher.start();
  try {
    const first = await waitUntilLive(dir, seen);
    await checkJavaScriptSkillReload(dir, seen, getSkillRegistry(), 'default-export');
    await checkJavaScriptSkillReload(dir, seen, getSkillRegistry(), 'module-exports');
    console.log(
      `skill watcher smoke ok: node ${process.version}, loaded "${first}", ` +
        'JavaScript skills reloaded with new code (default export and module.exports)'
    );
  } finally {
    await watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('skill watcher smoke FAILED:', error);
    process.exit(1);
  }
);
