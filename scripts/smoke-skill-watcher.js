#!/usr/bin/env node

/**
 * Smoke test for the built skill watcher. CI runs it after `npm run build`.
 *
 * The Jest suites compile chokidar (ES modules only since 5.0) to CommonJS,
 * so they cannot show whether the CommonJS build in dist/ can load the real
 * package with require(), or whether that package delivers file events.
 * This script checks both with plain Node: it loads dist/skills/watcher.js,
 * watches a temp directory and adds skill files until one is reported.
 * Exit code 1 means the build could not be loaded or no event arrived.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 15000;
const RETRY_MS = 1000;

function writeSkillFile(dir, name) {
  const content = `---\nname: ${name}\ntriggers: [${name}]\n---\nbody\n`;
  fs.writeFileSync(path.join(dir, `${name}.skill.md`), content);
}

async function waitForLoadedSkill(watcher, dir) {
  let loaded = null;
  watcher.on('loaded', (name) => {
    loaded = name;
  });
  watcher.on('error', (name, _file, error) => console.error('watcher error:', name, error));

  // Files that exist before the first scan ends are not reported, so keep
  // adding new ones until the watcher reports one.
  const deadline = Date.now() + TIMEOUT_MS;
  for (let attempt = 1; !loaded && Date.now() < deadline; attempt++) {
    writeSkillFile(dir, `smoke-${attempt}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  return loaded;
}

async function main() {
  const { SkillWatcher } = require('../dist/skills/watcher.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-watcher-smoke-'));
  const watcher = new SkillWatcher({ skillsDir: dir, debounceMs: 20 });
  let loaded = null;

  watcher.start();
  try {
    loaded = await waitForLoadedSkill(watcher, dir);
  } finally {
    await watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (!loaded) {
    throw new Error(`the watcher reported no 'loaded' event within ${TIMEOUT_MS} ms`);
  }
  console.log(`skill watcher smoke ok: node ${process.version}, loaded "${loaded}"`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('skill watcher smoke FAILED:', error);
    process.exit(1);
  }
);
