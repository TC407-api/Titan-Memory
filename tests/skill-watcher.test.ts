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
  message?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeSkillFile(dir: string, name: string, body = 'body'): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.skill.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ntriggers: [${name}]\n---\n${body}\n`);
  return file;
}

function writePlainFile(dir: string, fileName: string, content = 'export {};\n'): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Link `linkPath` to `target`. A directory link is a junction on Windows,
 * which needs no privilege. A file link on Windows needs Developer Mode or
 * an elevated shell; without it this returns false and the caller goes on
 * with the directory link only. Linux and macOS always create both.
 */
function tryLink(target: string, linkPath: string, kind: 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, linkPath, kind === 'dir' ? 'junction' : 'file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
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
  let errorSpy: jest.SpyInstance;

  const names = (event: SeenEvent['event']): string[] =>
    seen.filter((e) => e.event === event).map((e) => e.name);

  /** Messages of the 'error' events reported for one source file. */
  const errorsFor = (file: string): string[] =>
    seen
      .filter((e) => e.event === 'error' && path.resolve(e.file ?? '') === file)
      .map((e) => e.message ?? '');

  function startWatcher(options: { patterns?: string[]; ignored?: string[] } = {}): SkillWatcher {
    const created = new SkillWatcher({ skillsDir, debounceMs: 20, ...options });
    for (const event of ['loaded', 'reloaded', 'unloaded', 'error'] as const) {
      created.on(event, (name, file, error) =>
        seen.push({ event, name, file, message: error?.message })
      );
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
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
      watcher = null;
    }
    warnSpy.mockRestore();
    errorSpy.mockRestore();
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

  it('watches a skills directory that sits below directories named like ignored ones', async () => {
    // The default ignore globs apply below the skills directory, not to the
    // directories above it.
    skillsDir = path.join(tempRoot, 'dist', 'node_modules', 'tenant', 'skills');

    startWatcher();
    const probe = await primeWatcher();

    expect(getSkillRegistry().has(probe)).toBe(true);
  }, 30000);

  it('does not load skills that are reached through a symbolic link', async () => {
    const outside = path.join(tempRoot, 'outside');
    skillsDir = path.join(tempRoot, 'skills');
    writeSkillFile(outside, 'behind-dir-link');
    const linkedFileTarget = writeSkillFile(path.join(tempRoot, 'elsewhere'), 'behind-file-link');
    startWatcher();
    await primeWatcher();

    expect(tryLink(outside, path.join(skillsDir, 'linked'), 'dir')).toBe(true);
    tryLink(linkedFileTarget, path.join(skillsDir, 'direct-link.skill.md'), 'file');
    await sleep(SETTLE_MS);
    writeSkillFile(outside, 'added-behind-dir-link');
    writeSkillFile(skillsDir, 'kept-skill');
    await waitFor(() => names('loaded').includes('kept-skill'), "'loaded' for kept-skill");
    await sleep(SETTLE_MS);

    expect(names('loaded').filter((n) => !n.startsWith('probe-'))).toEqual(['kept-skill']);
    expect(getSkillRegistry().has('behind-dir-link')).toBe(false);
    expect(getSkillRegistry().has('behind-file-link')).toBe(false);
    expect(getSkillRegistry().has('added-behind-dir-link')).toBe(false);
  }, 30000);

  it('refuses a file behind a link even when a file event names it', async () => {
    // The filter keeps chokidar out of linked directories. The same check runs
    // again when an event is handled, in case one arrives anyway.
    const outside = path.join(tempRoot, 'outside');
    skillsDir = path.join(tempRoot, 'skills');
    writeSkillFile(outside, 'behind-link');
    const started = startWatcher();
    await primeWatcher();
    expect(tryLink(outside, path.join(skillsDir, 'linked'), 'dir')).toBe(true);
    const linkedFile = path.join(skillsDir, 'linked', 'behind-link.skill.md');

    const handlers = started as unknown as { loadFile(event: 'add', file: string): Promise<void> };
    await handlers.loadFile('add', linkedFile);

    expect(errorsFor(linkedFile)).toHaveLength(1);
    expect(errorsFor(linkedFile)[0]).toContain('symbolic link');
    expect(getSkillRegistry().has('behind-link')).toBe(false);
  }, 30000);

  describe.each([
    ['the default patterns', undefined],
    ['patterns that name code files', ['**/*.js', '**/*.ts', '**/*.skill.md']],
  ])('code files with %s', (_label, patterns) => {
    it('are never loaded, reloaded or unloaded', async () => {
      const codeFiles = ['plain.js', 'source.ts', 'named.skill.js', 'named.skill.ts'];
      startWatcher(patterns ? { patterns } : {});
      await primeWatcher();
      // A code skill that something else registered from a file in this directory.
      const registered = path.join(skillsDir, 'plain.js');
      getSkillRegistry().register({
        path: registered,
        metadata: { name: 'code-skill', version: '1.0.0', description: '', triggers: ['code'] },
        skill: {
          metadata: { name: 'code-skill', version: '1.0.0', description: '', triggers: ['code'] },
          execute: async () => ({ success: true }),
        },
        loadedAt: new Date(),
        lastModified: new Date(),
        enabled: true,
      });

      for (const name of codeFiles) writePlainFile(skillsDir, name, 'module.exports = {};\n');
      const kept = writeSkillFile(skillsDir, 'kept-skill');
      await waitFor(() => names('loaded').includes('kept-skill'), "'loaded' for kept-skill");
      for (const name of codeFiles) writePlainFile(skillsDir, name, 'module.exports = { edited: true };\n');
      writeSkillFile(skillsDir, 'kept-skill', 'a longer body than before');
      await waitFor(() => names('reloaded').includes('kept-skill'), "'reloaded' for kept-skill");
      for (const name of codeFiles) fs.rmSync(path.join(skillsDir, name));
      fs.rmSync(kept);
      await waitFor(() => names('unloaded').includes('kept-skill'), "'unloaded' for kept-skill");

      // Every event is about the .skill.md files: kept-skill and the probes.
      const aboutOtherFiles = seen.filter(
        (e) => e.name !== 'kept-skill' && !e.name.startsWith('probe-')
      );
      expect(aboutOtherFiles).toEqual([]);
      expect(names('error')).toEqual([]);
      expect(getSkillRegistry().has('code-skill')).toBe(true);
      // Under Jest a tried import() of a code file fails and is logged, and a
      // file the loader cannot use is warned about.
      expect(errorSpy).not.toHaveBeenCalled();
      const warned = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      for (const name of codeFiles) expect(warned).not.toContain(name);
    }, 30000);
  });

  it('keeps a disabled skill disabled when its file is saved again', async () => {
    startWatcher();
    await primeWatcher();
    writeSkillFile(skillsDir, 'quiet-skill');
    await waitFor(() => names('loaded').includes('quiet-skill'), "'loaded' for quiet-skill");
    expect(getSkillRegistry().disable('quiet-skill')).toBe(true);

    writeSkillFile(skillsDir, 'quiet-skill', 'a longer body than before');
    await waitFor(() => names('reloaded').includes('quiet-skill'), "'reloaded' for quiet-skill");

    expect(getSkillRegistry().has('quiet-skill')).toBe(true);
    expect(getSkillRegistry().isEnabled('quiet-skill')).toBe(false);
    expect(getSkillRegistry().findByText('please run quiet-skill')).toBeUndefined();
  }, 30000);

  it('keeps a disabled skill disabled through a broken save and a repaired one', async () => {
    startWatcher();
    await primeWatcher();
    const file = writeSkillFile(skillsDir, 'mended-skill');
    await waitFor(() => names('loaded').includes('mended-skill'), "'loaded' for mended-skill");
    getSkillRegistry().disable('mended-skill');

    // No frontmatter: the loader cannot load this version.
    fs.writeFileSync(file, 'saved half way through an edit\n');
    await waitFor(() => names('unloaded').includes('mended-skill'), "'unloaded' for mended-skill");
    expect(getSkillRegistry().has('mended-skill')).toBe(false);

    writeSkillFile(skillsDir, 'mended-skill', 'repaired');
    await waitFor(() => getSkillRegistry().has('mended-skill'), 'mended-skill registered again');

    expect(getSkillRegistry().isEnabled('mended-skill')).toBe(false);
  }, 30000);

  it('keeps a disabled skill disabled through a broken save and a repair under another name', async () => {
    startWatcher();
    await primeWatcher();
    const file = writeSkillFile(skillsDir, 'before-name');
    await waitFor(() => names('loaded').includes('before-name'), "'loaded' for before-name");
    getSkillRegistry().disable('before-name');

    fs.writeFileSync(file, 'saved half way through an edit\n');
    await waitFor(() => names('unloaded').includes('before-name'), "'unloaded' for before-name");
    fs.writeFileSync(file, '---\nname: after-name\ntriggers: [after-name]\n---\nrepaired\n');
    await waitFor(() => getSkillRegistry().has('after-name'), 'after-name registered');

    expect(getSkillRegistry().isEnabled('after-name')).toBe(false);
  }, 30000);

  it('reports the old name as unloaded when a save gives the skill another name', async () => {
    startWatcher();
    await primeWatcher();
    const file = writeSkillFile(skillsDir, 'old-title');
    await waitFor(() => names('loaded').includes('old-title'), "'loaded' for old-title");

    fs.writeFileSync(file, '---\nname: new-title\ntriggers: [new-title]\n---\nrenamed\n');
    await waitFor(() => names('reloaded').includes('new-title'), "'reloaded' for new-title");

    expect(names('unloaded')).toEqual(['old-title']);
    expect(getSkillRegistry().has('old-title')).toBe(false);
    expect(getSkillRegistry().has('new-title')).toBe(true);
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
