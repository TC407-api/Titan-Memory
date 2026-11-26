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
import { loadSkillFromFile } from '../src/skills/loader';

const EVENT_TIMEOUT_MS = 10000;
const POLL_MS = 25;
// Longer than awaitWriteFinish (200 ms stable + 100 ms poll) plus the debounce.
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

  /** Write a skill file and wait until the watcher reports it as loaded. */
  async function addAndWaitForLoad(dir: string, name: string): Promise<string> {
    const file = writeSkillFile(dir, name);
    await waitFor(() => names('loaded').includes(name), `'loaded' for ${name}`);
    return file;
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

    const file = await addAndWaitForLoad(skillsDir, 'added-skill');

    const hit = seen.find((e) => e.event === 'loaded' && e.name === 'added-skill');
    expect(path.resolve(hit?.file ?? '')).toBe(file);
    expect(getSkillRegistry().has('added-skill')).toBe(true);
  }, 30000);

  it('loads a skill file that is added in a subdirectory', async () => {
    startWatcher();
    await addAndWaitForLoad(skillsDir, 'first-skill');

    writeSkillFile(path.join(skillsDir, 'custom', 'nested'), 'deep-skill');

    await waitFor(() => names('loaded').includes('deep-skill'), "'loaded' for deep-skill");
    expect(getSkillRegistry().has('deep-skill')).toBe(true);
  }, 30000);

  it('creates a missing skills directory and then reports skills added to it', async () => {
    skillsDir = path.join(tempRoot, 'not', 'there', 'yet');

    startWatcher();
    expect(fs.statSync(skillsDir).isDirectory()).toBe(true);

    await addAndWaitForLoad(skillsDir, 'in-new-dir');
    expect(getSkillRegistry().has('in-new-dir')).toBe(true);
  }, 30000);

  it('reloads a changed skill file and unloads a deleted one', async () => {
    startWatcher();
    const file = await addAndWaitForLoad(skillsDir, 'cycle-skill');

    writeSkillFile(skillsDir, 'cycle-skill', 'a longer body than before');
    await waitFor(() => names('reloaded').includes('cycle-skill'), "'reloaded' for cycle-skill");

    fs.rmSync(file);
    await waitFor(() => names('unloaded').includes('cycle-skill'), "'unloaded' for cycle-skill");
    expect(getSkillRegistry().has('cycle-skill')).toBe(false);
  }, 30000);

  it('reports nothing for ignored directories, declaration files and other file types', async () => {
    startWatcher();
    writeSkillFile(path.join(skillsDir, '.disabled'), 'disabled-skill');
    writeSkillFile(path.join(skillsDir, 'node_modules', 'pkg'), 'vendored-skill');
    writeSkillFile(path.join(skillsDir, 'custom', 'dist'), 'built-skill');
    writePlainFile(skillsDir, 'types.d.ts');
    writePlainFile(skillsDir, 'notes.txt');
    writeSkillFile(skillsDir, 'kept-skill');
    await waitFor(() => names('loaded').includes('kept-skill'), "'loaded' for kept-skill");
    await sleep(SETTLE_MS);

    expect(names('loaded')).toEqual(['kept-skill']);
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
    await addAndWaitForLoad(skillsDir, 'tenant-skill');

    expect(getSkillRegistry().has('tenant-skill')).toBe(true);
  }, 30000);

  it('does not load skills that are reached through a symbolic link', async () => {
    const outside = path.join(tempRoot, 'outside');
    skillsDir = path.join(tempRoot, 'skills');
    writeSkillFile(outside, 'behind-dir-link');
    const linkedFileTarget = writeSkillFile(path.join(tempRoot, 'elsewhere'), 'behind-file-link');
    startWatcher();
    expect(tryLink(outside, path.join(skillsDir, 'linked'), 'dir')).toBe(true);
    tryLink(linkedFileTarget, path.join(skillsDir, 'direct-link.skill.md'), 'file');
    await sleep(SETTLE_MS);
    writeSkillFile(outside, 'added-behind-dir-link');
    writeSkillFile(skillsDir, 'kept-skill');
    await waitFor(() => names('loaded').includes('kept-skill'), "'loaded' for kept-skill");
    await sleep(SETTLE_MS);

    expect(names('loaded')).toEqual(['kept-skill']);
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
    expect(tryLink(outside, path.join(skillsDir, 'linked'), 'dir')).toBe(true);
    const linkedFile = path.join(skillsDir, 'linked', 'behind-link.skill.md');

    const handlers = started as unknown as { loadFile(event: 'add', file: string): Promise<void> };
    await handlers.loadFile('add', linkedFile);

    expect(errorsFor(linkedFile)).toHaveLength(1);
    expect(errorsFor(linkedFile)[0]).toContain('symbolic link');
    expect(getSkillRegistry().has('behind-link')).toBe(false);
  }, 30000);

  it('loads the .skill.md files that are already there when start() is called', async () => {
    writeSkillFile(skillsDir, 'present-skill');
    writeSkillFile(path.join(skillsDir, 'custom'), 'present-nested');
    writeSkillFile(path.join(skillsDir, '.disabled'), 'present-but-ignored');

    startWatcher();

    await waitFor(
      () => names('loaded').includes('present-skill') && names('loaded').includes('present-nested'),
      "'loaded' for the files that were there before start()"
    );
    expect(getSkillRegistry().has('present-skill')).toBe(true);
    expect(getSkillRegistry().has('present-nested')).toBe(true);
    await sleep(SETTLE_MS);
    expect(getSkillRegistry().has('present-but-ignored')).toBe(false);
  }, 30000);

  it('loads a file that is written right after start() returns', async () => {
    // Before the first scan has finished: the file is either found by that
    // scan or reported as added, and loaded either way.
    startWatcher();
    writeSkillFile(skillsDir, 'right-after-start');

    await waitFor(() => names('loaded').includes('right-after-start'), "'loaded' for right-after-start");
    expect(getSkillRegistry().has('right-after-start')).toBe(true);
  }, 30000);

  describe.each([
    ['a link to a file outside the skills directory', 'file'],
    ['a dangling link', 'dangling'],
  ])('a loaded skill file that is replaced by %s', (_label, kind) => {
    it('is unloaded, and the link is not read', async () => {
      skillsDir = path.join(tempRoot, 'skills');
      const outsideFile = writeSkillFile(path.join(tempRoot, 'outside'), 'outside-skill');
      const target = kind === 'file' ? outsideFile : path.join(tempRoot, 'missing.skill.md');
      startWatcher();
      const file = writeSkillFile(skillsDir, 'swapped-skill');
      await waitFor(() => names('loaded').includes('swapped-skill'), "'loaded' for swapped-skill");

      // Atomic replacement: create the link next to the file, rename it over the file.
      const linkPath = path.join(skillsDir, 'swap.tmp');
      if (!tryLink(target, linkPath, 'file')) return; // Windows without Developer Mode
      fs.renameSync(linkPath, file);

      await waitFor(() => names('unloaded').includes('swapped-skill'), "'unloaded' for swapped-skill");
      expect(getSkillRegistry().has('swapped-skill')).toBe(false);
      expect(getSkillRegistry().has('outside-skill')).toBe(false);
      // A dangling link can be reported as a delete, which needs no error.
      if (kind === 'file') expect(errorsFor(file).join('\n')).toContain('symbolic link');
    }, 30000);
  });

  it('refuses a skills directory that is itself a link', () => {
    const realDir = path.join(tempRoot, 'real-skills');
    fs.mkdirSync(realDir);
    skillsDir = path.join(tempRoot, 'linked-skills');
    expect(tryLink(realDir, skillsDir, 'dir')).toBe(true);
    const created = new SkillWatcher({ skillsDir, debounceMs: 20 });

    expect(() => created.start()).toThrow('symbolic link');
    expect(created.isWatching()).toBe(false);
  });

  describe('a skills directory below a linked directory', () => {
    // The skills directory is a real directory; a directory above it is a link.
    let linkedParent: string;

    beforeEach(() => {
      const realParent = path.join(tempRoot, 'real-parent');
      fs.mkdirSync(path.join(realParent, 'skills'), { recursive: true });
      linkedParent = path.join(tempRoot, 'linked-parent');
      expect(tryLink(realParent, linkedParent, 'dir')).toBe(true);
      skillsDir = path.join(linkedParent, 'skills');
    });

    it('reloads and unloads a skill that was loaded through the same path before start()', async () => {
      const file = writeSkillFile(skillsDir, 'preloaded');
      const preloaded = await loadSkillFromFile(file);
      getSkillRegistry().register(preloaded!);
      startWatcher();
      // The first scan finds the file and loads it again, under the same path.
      await waitFor(() => names('loaded').includes('preloaded'), "'loaded' for preloaded");

      writeSkillFile(skillsDir, 'preloaded', 'edited after start');
      await waitFor(() => names('reloaded').includes('preloaded'), "'reloaded' for preloaded");
      expect(getSkillRegistry().getFile('preloaded')?.path).toBe(file);
      expect(errorsFor(file)).toEqual([]);

      fs.rmSync(file);
      await waitFor(() => names('unloaded').includes('preloaded'), "'unloaded' for preloaded");
      expect(getSkillRegistry().has('preloaded')).toBe(false);
    }, 30000);

    it('applies an absolute ignored glob written with that path', async () => {
      startWatcher({ ignored: [path.join(skillsDir, 'drafts', '**')] });

      writeSkillFile(path.join(skillsDir, 'drafts'), 'draft-skill');
      await addAndWaitForLoad(skillsDir, 'kept-skill');
      await sleep(SETTLE_MS);

      expect(getSkillRegistry().has('draft-skill')).toBe(false);
      expect(names('loaded')).toEqual(['kept-skill']);
    }, 30000);
  });

  it('does not let a .skill.md file take the name of a skill registered from another file', async () => {
    const codePath = path.join(skillsDir, 'report.js');
    getSkillRegistry().register({
      path: codePath,
      metadata: { name: 'report', version: '1.0.0', description: '', triggers: ['report'] },
      skill: {
        metadata: { name: 'report', version: '1.0.0', description: '', triggers: ['report'] },
        execute: async () => ({ success: true, output: 'code' }),
      },
      loadedAt: new Date(),
      lastModified: new Date(),
      enabled: true,
    });
    startWatcher();

    const markdown = writeSkillFile(skillsDir, 'report');
    await waitFor(() => errorsFor(path.resolve(markdown)).length > 0, "an 'error' for report.skill.md");
    expect(errorsFor(path.resolve(markdown))[0]).toContain(codePath);
    expect(getSkillRegistry().getFile('report')?.path).toBe(codePath);

    fs.rmSync(markdown);
    await sleep(SETTLE_MS);
    expect(getSkillRegistry().getFile('report')?.path).toBe(codePath);
    expect(names('loaded')).toEqual([]);
    expect(names('unloaded')).toEqual([]);
  }, 30000);

  it('unloads the skills it loaded when it is stopped, and loads them again on start()', async () => {
    const started = startWatcher();
    await addAndWaitForLoad(skillsDir, 'while-running');
    // Registered by something else, from a file the watcher does not handle.
    getSkillRegistry().register({
      path: path.join(skillsDir, 'other.js'),
      metadata: { name: 'other-skill', version: '1.0.0', description: '', triggers: ['other'] },
      skill: {
        metadata: { name: 'other-skill', version: '1.0.0', description: '', triggers: ['other'] },
        execute: async () => ({ success: true }),
      },
      loadedAt: new Date(),
      lastModified: new Date(),
      enabled: true,
    });

    const stopping = started.stop();
    // Unloaded before stop() first waits.
    expect(getSkillRegistry().has('while-running')).toBe(false);
    await stopping;
    expect(names('unloaded')).toEqual(['while-running']);
    expect(getSkillRegistry().has('other-skill')).toBe(true);

    started.start();
    await waitFor(() => getSkillRegistry().has('while-running'), 'while-running registered again');
  }, 30000);

  it('does not keep a skill whose file was deleted while the watcher was stopped', async () => {
    const started = startWatcher();
    const file = await addAndWaitForLoad(skillsDir, 'gone-while-stopped');
    await started.stop();

    fs.rmSync(file);
    started.start();
    await addAndWaitForLoad(skillsDir, 'after-restart');

    expect(getSkillRegistry().has('gone-while-stopped')).toBe(false);
  }, 30000);

  it('does not keep a skill whose file was replaced by a directory while the watcher was stopped', async () => {
    const started = startWatcher();
    const file = await addAndWaitForLoad(skillsDir, 'became-dir');
    await started.stop();

    fs.rmSync(file);
    fs.mkdirSync(file);
    started.start();
    await addAndWaitForLoad(skillsDir, 'after-restart');
    await sleep(SETTLE_MS);

    expect(getSkillRegistry().has('became-dir')).toBe(false);
  }, 30000);

  it('keeps a disabled skill disabled through stop() and start()', async () => {
    const started = startWatcher();
    await addAndWaitForLoad(skillsDir, 'off-while-stopped');
    expect(getSkillRegistry().disable('off-while-stopped')).toBe(true);
    await started.stop();

    started.start();
    await waitFor(() => getSkillRegistry().has('off-while-stopped'), 'off-while-stopped registered again');

    expect(getSkillRegistry().isEnabled('off-while-stopped')).toBe(false);
  }, 30000);

  describe.each([
    ['the default patterns', undefined],
    ['patterns that name code files', ['**/*.js', '**/*.ts', '**/*.skill.md']],
  ])('code files with %s', (_label, patterns) => {
    it('are never loaded, reloaded or unloaded', async () => {
      const codeFiles = ['plain.js', 'source.ts', 'named.skill.js', 'named.skill.ts'];
      startWatcher(patterns ? { patterns } : {});
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

      // Every event is about the .skill.md file kept-skill.
      const aboutOtherFiles = seen.filter(
        (e) => e.name !== 'kept-skill'
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
    writeSkillFile(skillsDir, 'outside-skill');
    writeSkillFile(path.join(wanted, 'drafts'), 'draft-skill');
    writeSkillFile(path.join(wanted, 'team'), 'team-skill');
    await waitFor(() => names('loaded').includes('team-skill'), "'loaded' for team-skill");
    await sleep(SETTLE_MS);

    expect(names('loaded')).toEqual(['team-skill']);
  }, 30000);
});
