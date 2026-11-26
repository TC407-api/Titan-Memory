/**
 * Tests for which file events reach the loader: none after the watcher has
 * stopped, and only those for .skill.md files.
 *
 * loadSkillFromFile is wrapped in a mock that calls the real function, so
 * the tests can see what the watcher hands it. Files, chokidar events and
 * the registry are real.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillWatcher } from '../src/skills/watcher';
import { getSkillRegistry, resetSkillRegistry } from '../src/skills/registry';
import * as loader from '../src/skills/loader';

jest.mock('../src/skills/loader', () => {
  const actual = jest.requireActual('../src/skills/loader');
  return {
    ...actual,
    loadSkillFromFile: jest.fn(actual.loadSkillFromFile),
  };
});

const actualLoader = jest.requireActual<typeof loader>('../src/skills/loader');
const loadSkillMock = loader.loadSkillFromFile as jest.MockedFunction<typeof loader.loadSkillFromFile>;

const EVENT_TIMEOUT_MS = 10000;
const POLL_MS = 25;
// Longer than awaitWriteFinish (200 ms stable + 100 ms poll) plus the debounce.
const SETTLE_MS = 1200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeSkillFile(dir: string, name: string, body = 'body'): string {
  const file = path.join(dir, `${name}.skill.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ntriggers: [${name}]\n---\n${body}\n`);
  return file;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(POLL_MS);
  }
  throw new Error(`timed out after ${EVENT_TIMEOUT_MS} ms waiting for ${what}`);
}

describe('SkillWatcher: which file events reach the loader', () => {
  let skillsDir: string;
  let watcher: SkillWatcher;
  let seen: Array<{ event: string; name: string }> = [];
  let warnSpy: jest.SpyInstance;

  const names = (event: string): string[] =>
    seen.filter((e) => e.event === event).map((e) => e.name);

  beforeEach(() => {
    resetSkillRegistry();
    seen = [];
    loadSkillMock.mockClear();
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-skill-order-'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    watcher = new SkillWatcher({ skillsDir, debounceMs: 20 });
    for (const event of ['loaded', 'reloaded', 'unloaded', 'error'] as const) {
      watcher.on(event, (name) => seen.push({ event, name }));
    }
    watcher.start();
  });

  afterEach(async () => {
    await watcher.stop();
    warnSpy.mockRestore();
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it('ignores file events that arrive after the watcher is stopped', async () => {
    writeSkillFile(skillsDir, 'early-skill');
    await waitFor(() => names('loaded').includes('early-skill'), "'loaded' for early-skill");
    const callsBefore = loadSkillMock.mock.calls.length;

    // Written inside the debounce and write-finish window, then stopped.
    writeSkillFile(skillsDir, 'late-skill');
    await watcher.stop();
    await sleep(SETTLE_MS);

    expect(loadSkillMock.mock.calls.length).toBe(callsBefore);
    expect(getSkillRegistry().has('late-skill')).toBe(false);
  }, 30000);

  it('reports a file that is added and then changed before its load runs as loaded', async () => {
    const handlers = watcher as unknown as {
      handleFileChange(event: 'add' | 'change', file: string): void;
    };
    // A file added after the first scan, so chokidar waits for the write to
    // finish (200 ms) before it reports this one.
    writeSkillFile(skillsDir, 'warm-up');
    await waitFor(() => names('loaded').includes('warm-up'), "'loaded' for warm-up");
    await sleep(SETTLE_MS);
    seen = [];
    const file = writeSkillFile(skillsDir, 'fresh-skill');
    // Inside one debounce window, before chokidar reports the file itself.
    handlers.handleFileChange('add', file);
    handlers.handleFileChange('change', file);
    await waitFor(() => seen.length > 0, 'the first event');

    expect(seen[0]).toEqual({ event: 'loaded', name: 'fresh-skill' });
    await sleep(SETTLE_MS);
  }, 30000);

  it('hands only .skill.md files to the loader, whatever file an event names', async () => {
    // Called directly, so the result does not depend on what chokidar reports.
    const handlers = watcher as unknown as {
      handleFileChange(event: 'add' | 'change', file: string): void;
      handleFileUnlink(file: string): void;
    };
    const inDir = (name: string): string => path.join(skillsDir, name);
    const others = ['plain.js', 'source.ts', 'named.skill.js', 'named.skill.ts', 'notes.md'].map(inDir);
    const skillFile = writeSkillFile(skillsDir, 'only-skill');
    // A code skill that something else registered from one of these files.
    const codeSkill = { ...(await actualLoader.loadSkillFromFile(skillFile))! };
    codeSkill.path = inDir('plain.js');
    codeSkill.metadata = { ...codeSkill.metadata, name: 'code-skill' };
    getSkillRegistry().register(codeSkill);
    const loadedPaths = (): string[] => loadSkillMock.mock.calls.map(([skillPath]) => skillPath);

    // The timers of the earlier calls run before the timer of the last one.
    for (const file of others) {
      fs.writeFileSync(file, 'module.exports = {};\n');
      handlers.handleFileChange('add', file);
      handlers.handleFileChange('change', file);
    }
    handlers.handleFileChange('change', skillFile);
    await waitFor(() => loadedPaths().includes(skillFile), 'the load of only-skill');
    for (const file of others) handlers.handleFileUnlink(file);
    handlers.handleFileUnlink(skillFile);
    await waitFor(() => names('unloaded').includes('only-skill'), "'unloaded' for only-skill");

    expect(loadedPaths().filter((file) => others.includes(file))).toEqual([]);
    expect(getSkillRegistry().has('code-skill')).toBe(true);
    expect(names('error')).toEqual([]);
  }, 30000);
});
