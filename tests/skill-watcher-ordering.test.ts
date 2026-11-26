/**
 * Ordering tests for SkillWatcher: what happens when a file event arrives
 * while an earlier load of the same file is still running, and which files
 * reach the loader at all.
 *
 * A load takes time when the version it replaces has an asynchronous
 * onUnload(). A .skill.md skill has no hooks of its own, so reloadSkill is
 * replaced here by a version that does the real load and then waits before
 * it registers the skill. Files, chokidar events and the registry are real.
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
    reloadSkill: jest.fn(actual.reloadSkill),
    unloadSkill: jest.fn(actual.unloadSkill),
  };
});

const actualLoader = jest.requireActual<typeof loader>('../src/skills/loader');
const reloadSkillMock = loader.reloadSkill as jest.MockedFunction<typeof loader.reloadSkill>;
const unloadSkillMock = loader.unloadSkill as jest.MockedFunction<typeof loader.unloadSkill>;

const EVENT_TIMEOUT_MS = 10000;
const POLL_MS = 25;
const PRIME_RETRY_MS = 1000;
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

describe('SkillWatcher ordering of events for one file', () => {
  let skillsDir: string;
  let watcher: SkillWatcher;
  let seen: Array<{ event: string; name: string }> = [];
  let warnSpy: jest.SpyInstance;
  let releaseLoad: () => void = () => undefined;
  let slowLoadsStarted = 0;

  const names = (event: string): string[] =>
    seen.filter((e) => e.event === event).map((e) => e.name);

  /**
   * Make the next load of `slowFile` wait: the file has been read, the skill
   * is not registered yet.
   */
  function holdNextLoadOf(slowFile: string): void {
    const released = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    reloadSkillMock.mockImplementation(async (skillPath) => {
      if (skillPath !== slowFile || slowLoadsStarted > 0) {
        return actualLoader.reloadSkill(skillPath);
      }
      slowLoadsStarted += 1;
      const skillFile = await actualLoader.loadSkillFromFile(skillPath);
      await released;
      if (skillFile) getSkillRegistry().register(skillFile);
      return skillFile;
    });
  }

  async function primeWatcher(): Promise<void> {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      writeSkillFile(skillsDir, `probe-${attempt}`);
      const retryAt = Date.now() + PRIME_RETRY_MS;
      while (Date.now() < retryAt) {
        if (names('loaded').some((n) => n.startsWith('probe-'))) return;
        await sleep(POLL_MS);
      }
    }
    throw new Error(`the watcher reported no 'loaded' event within ${EVENT_TIMEOUT_MS} ms`);
  }

  beforeEach(() => {
    resetSkillRegistry();
    seen = [];
    slowLoadsStarted = 0;
    reloadSkillMock.mockImplementation(actualLoader.reloadSkill);
    reloadSkillMock.mockClear();
    unloadSkillMock.mockClear();
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-skill-order-'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    watcher = new SkillWatcher({ skillsDir, debounceMs: 20 });
    for (const event of ['loaded', 'reloaded', 'unloaded', 'error'] as const) {
      watcher.on(event, (name) => seen.push({ event, name }));
    }
    watcher.start();
  });

  afterEach(async () => {
    releaseLoad();
    await watcher.stop();
    warnSpy.mockRestore();
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it('unloads a skill whose file is deleted while its load is still running', async () => {
    await primeWatcher();
    const slowFile = path.join(skillsDir, 'slow-skill.skill.md');
    holdNextLoadOf(slowFile);

    writeSkillFile(skillsDir, 'slow-skill');
    await waitFor(() => slowLoadsStarted === 1, 'the slow load to start');
    fs.rmSync(slowFile);
    await sleep(SETTLE_MS);
    releaseLoad();

    await waitFor(() => names('unloaded').includes('slow-skill'), "'unloaded' for slow-skill");
    expect(getSkillRegistry().has('slow-skill')).toBe(false);
    expect(seen.map((e) => `${e.event}:${e.name}`).filter((e) => e.endsWith(':slow-skill'))).toEqual([
      'loaded:slow-skill',
      'unloaded:slow-skill',
    ]);
  }, 30000);

  it('runs a second save of the same file only after the first load has finished', async () => {
    await primeWatcher();
    const slowFile = path.join(skillsDir, 'twice-skill.skill.md');
    holdNextLoadOf(slowFile);

    writeSkillFile(skillsDir, 'twice-skill');
    await waitFor(() => slowLoadsStarted === 1, 'the slow load to start');
    writeSkillFile(skillsDir, 'twice-skill', 'saved again while the first load is running');
    await sleep(SETTLE_MS);

    const loadsOf = (): number =>
      reloadSkillMock.mock.calls.filter(([skillPath]) => skillPath === slowFile).length;
    expect(loadsOf()).toBe(1);
    releaseLoad();

    await waitFor(() => names('reloaded').includes('twice-skill'), "'reloaded' for twice-skill");
    expect(loadsOf()).toBe(2);
    expect(getSkillRegistry().has('twice-skill')).toBe(true);
  }, 30000);

  it('stops without waiting for a running load, and still applies the delete seen before the stop', async () => {
    await primeWatcher();
    const slowFile = path.join(skillsDir, 'halted-skill.skill.md');
    holdNextLoadOf(slowFile);

    writeSkillFile(skillsDir, 'halted-skill');
    await waitFor(() => slowLoadsStarted === 1, 'the slow load to start');
    fs.rmSync(slowFile);
    await sleep(SETTLE_MS);

    // stop() returns while the load is still held.
    await watcher.stop();
    expect(watcher.isWatching()).toBe(false);
    expect(getSkillRegistry().has('halted-skill')).toBe(false);

    releaseLoad();
    await waitFor(() => names('unloaded').includes('halted-skill'), "'unloaded' for halted-skill");
    expect(getSkillRegistry().has('halted-skill')).toBe(false);
  }, 30000);

  it('ignores file events that arrive after the watcher is stopped', async () => {
    await primeWatcher();
    const callsBefore = reloadSkillMock.mock.calls.length;

    // Written inside the debounce and write-finish window, then stopped.
    writeSkillFile(skillsDir, 'late-skill');
    await watcher.stop();
    await sleep(SETTLE_MS);

    expect(reloadSkillMock.mock.calls.length).toBe(callsBefore);
    expect(getSkillRegistry().has('late-skill')).toBe(false);
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
    const loadedPaths = (): string[] => reloadSkillMock.mock.calls.map(([skillPath]) => skillPath);

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
    expect(unloadSkillMock.mock.calls.map(([name]) => name)).not.toContain('code-skill');
    expect(getSkillRegistry().has('code-skill')).toBe(true);
    expect(names('error')).toEqual([]);
  }, 30000);
});
