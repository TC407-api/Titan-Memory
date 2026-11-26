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

  it('refuses a compiled file that is reached through a linked dist directory', async () => {
    // For a .ts file the loader imports the compiled file, which is another
    // path: <project>/dist/skills/x.js for <project>/src/skills/x.ts.
    skillsDir = path.join(tempRoot, 'skills');
    const outsideDist = path.join(tempRoot, 'outside-dist');
    writePlainFile(path.join(outsideDist, 'skills'), 'x.js', 'module.exports = {};\n');
    startWatcher();
    await primeWatcher();

    const project = path.join(skillsDir, 'project');
    fs.mkdirSync(path.join(project, 'src', 'skills'), { recursive: true });
    expect(tryLink(outsideDist, path.join(project, 'dist'), 'dir')).toBe(true);
    const source = writePlainFile(path.join(project, 'src', 'skills'), 'x.ts');

    await waitFor(() => errorsFor(source).length > 0, "'error' for x.ts");
    expect(errorsFor(source)[0]).toContain(path.join(project, 'dist', 'skills', 'x.js'));
    expect(errorsFor(source)[0]).toContain('symbolic link');
    // No import was tried: under Jest a tried import fails and is logged.
    expect(errorSpy).not.toHaveBeenCalled();
  }, 30000);

  it('refuses a compiled sibling file that is a symbolic link', async () => {
    skillsDir = path.join(tempRoot, 'skills');
    const target = writePlainFile(
      path.join(tempRoot, 'elsewhere'),
      'y.js',
      'module.exports = {};\n'
    );
    startWatcher();
    await primeWatcher();

    const linked = tryLink(target, path.join(skillsDir, 'y.js'), 'file');
    if (!linked) {
      // Only Windows without Developer Mode may refuse a file link.
      expect(process.platform).toBe('win32');
      return;
    }
    await sleep(SETTLE_MS);
    const source = writePlainFile(skillsDir, 'y.ts');

    await waitFor(() => errorsFor(source).length > 0, "'error' for y.ts");
    expect(errorsFor(source)[0]).toContain(path.join(skillsDir, 'y.js'));
    expect(errorSpy).not.toHaveBeenCalled();
  }, 30000);

  it('refuses a compiled file that is outside the skills directory', async () => {
    // With a skills directory named src/skills, the compiled file the loader
    // picks is in the dist/skills directory next to it, outside the watched one.
    skillsDir = path.join(tempRoot, 'src', 'skills');
    const compiled = writePlainFile(
      path.join(tempRoot, 'dist', 'skills'),
      'z.js',
      'module.exports = {};\n'
    );
    startWatcher();
    await primeWatcher();

    const source = writePlainFile(skillsDir, 'z.ts');

    await waitFor(() => errorsFor(source).length > 0, "'error' for z.ts");
    expect(errorsFor(source)[0]).toContain(compiled);
    expect(errorsFor(source)[0]).toContain('outside the skills directory');
    expect(errorSpy).not.toHaveBeenCalled();
  }, 30000);

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
