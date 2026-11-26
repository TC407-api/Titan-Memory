/**
 * End-to-end tests for SkillWatcher: real files in a temp directory, real
 * chokidar events, the real loader and registry. Nothing is mocked, because
 * the failure these tests guard against (the watcher being handed targets it
 * never reports on) is invisible to a test that only checks isWatching().
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillWatcher } from '../src/skills/watcher';
import { getSkillRegistry, resetSkillRegistry } from '../src/skills/registry';

const EVENT_TIMEOUT_MS = 10000;
const POLL_MS = 25;
// Longer than awaitWriteFinish (200 ms stable + 100 ms poll) plus the debounce.
const PRIME_RETRY_MS = 1000;
const SETTLE_MS = 1200;

interface SeenEvent {
  event: 'loaded' | 'reloaded' | 'unloaded' | 'error';
  name: string;
  file?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeSkillFile(dir: string, name: string, body = 'body'): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.skill.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ntriggers: [${name}]\n---\n${body}\n`);
  return file;
}

function writePlainFile(dir: string, fileName: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, 'export {};\n');
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

describe('SkillWatcher file events (end to end)', () => {
  let tempRoot: string;
  let skillsDir: string;
  let watcher: SkillWatcher | null = null;
  let seen: SeenEvent[] = [];
  let warnSpy: jest.SpyInstance;

  const names = (event: SeenEvent['event']): string[] =>
    seen.filter((e) => e.event === event).map((e) => e.name);

  function startWatcher(options: { patterns?: string[]; ignored?: string[] } = {}): SkillWatcher {
    const created = new SkillWatcher({ skillsDir, debounceMs: 20, ...options });
    for (const event of ['loaded', 'reloaded', 'unloaded', 'error'] as const) {
      created.on(event, (name, file) => seen.push({ event, name, file }));
    }
    created.start();
    watcher = created;
    return created;
  }

  /**
   * The watcher ignores files that exist before its first scan ends, and it
   * exposes no ready signal. So keep adding probe skills until one is
   * reported: from then on the watcher is known to be live.
   */
  async function primeWatcher(dir: string = skillsDir): Promise<string> {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      const probe = `probe-${attempt}`;
      writeSkillFile(dir, probe);
      const retryAt = Date.now() + PRIME_RETRY_MS;
      while (Date.now() < retryAt) {
        const hit = names('loaded').find((n) => n.startsWith('probe-'));
        if (hit) return hit;
        await sleep(POLL_MS);
      }
    }
    throw new Error(
      `the watcher reported no 'loaded' event for a new skill file within ${EVENT_TIMEOUT_MS} ms`
    );
  }

  beforeEach(() => {
    resetSkillRegistry();
    seen = [];
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-skill-watcher-'));
    skillsDir = tempRoot;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
      watcher = null;
    }
    warnSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('loads a skill file that is added to the watched directory', async () => {
    startWatcher();

    const probe = await primeWatcher();

    const hit = seen.find((e) => e.event === 'loaded' && e.name === probe);
    expect(path.resolve(hit?.file ?? '')).toBe(path.join(skillsDir, `${probe}.skill.md`));
    expect(getSkillRegistry().has(probe)).toBe(true);
  }, 30000);

  it('loads a skill file that is added in a subdirectory', async () => {
    startWatcher();
    await primeWatcher();

    writeSkillFile(path.join(skillsDir, 'custom', 'nested'), 'deep-skill');

    await waitFor(() => names('loaded').includes('deep-skill'), "'loaded' for deep-skill");
    expect(getSkillRegistry().has('deep-skill')).toBe(true);
  }, 30000);

  it('creates a missing skills directory and then reports skills added to it', async () => {
    skillsDir = path.join(tempRoot, 'not', 'there', 'yet');

    startWatcher();
    expect(fs.statSync(skillsDir).isDirectory()).toBe(true);

    const probe = await primeWatcher();
    expect(getSkillRegistry().has(probe)).toBe(true);
  }, 30000);

  it('reloads a changed skill file and unloads a deleted one', async () => {
    startWatcher();
    await primeWatcher();
    const file = writeSkillFile(skillsDir, 'cycle-skill');
    await waitFor(() => names('loaded').includes('cycle-skill'), "'loaded' for cycle-skill");

    writeSkillFile(skillsDir, 'cycle-skill', 'a longer body than before');
    await waitFor(() => names('reloaded').includes('cycle-skill'), "'reloaded' for cycle-skill");

    fs.rmSync(file);
    await waitFor(() => names('unloaded').includes('cycle-skill'), "'unloaded' for cycle-skill");
    expect(getSkillRegistry().has('cycle-skill')).toBe(false);
  }, 30000);

  it('reports nothing for ignored directories, declaration files and other file types', async () => {
    startWatcher();
    await primeWatcher();

    writeSkillFile(path.join(skillsDir, '.disabled'), 'disabled-skill');
    writeSkillFile(path.join(skillsDir, 'node_modules', 'pkg'), 'vendored-skill');
    writeSkillFile(path.join(skillsDir, 'custom', 'dist'), 'built-skill');
    writePlainFile(skillsDir, 'types.d.ts');
    writePlainFile(skillsDir, 'notes.txt');
    writeSkillFile(skillsDir, 'kept-skill');
    await waitFor(() => names('loaded').includes('kept-skill'), "'loaded' for kept-skill");
    await sleep(SETTLE_MS);

    expect(names('loaded').filter((n) => !n.startsWith('probe-'))).toEqual(['kept-skill']);
    expect(names('error')).toEqual([]);
    // The loader warns about any file it is handed and cannot load, so a
    // declaration or text file that got through the filter shows up here.
    const warned = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('types.d.ts');
    expect(warned).not.toContain('notes.txt');
  }, 30000);

  it('honours custom patterns and ignored options', async () => {
    const wanted = path.join(skillsDir, 'custom');
    startWatcher({ patterns: ['custom/**/*.skill.md'], ignored: ['**/drafts/**'] });
    await primeWatcher(wanted);

    writeSkillFile(skillsDir, 'outside-skill');
    writeSkillFile(path.join(wanted, 'drafts'), 'draft-skill');
    writeSkillFile(path.join(wanted, 'team'), 'team-skill');
    await waitFor(() => names('loaded').includes('team-skill'), "'loaded' for team-skill");
    await sleep(SETTLE_MS);

    expect(names('loaded').filter((n) => !n.startsWith('probe-'))).toEqual(['team-skill']);
  }, 30000);
});
