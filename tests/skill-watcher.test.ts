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
import type { SkillFile } from '../src/skills/types';

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

/** A code skill, as something other than the watcher would register it from `filePath`. */
function codeSkillFile(filePath: string, name: string, triggers: string[]): SkillFile {
  const metadata = { name, version: '1.0.0', description: '', triggers };
  return {
    path: filePath,
    metadata,
    skill: { metadata, execute: async () => ({ success: true, output: 'code' }) },
    loadedAt: new Date(),
    lastModified: new Date(),
    enabled: true,
  };
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

  it('registers nothing after a listener stops it in the middle of a load', async () => {
    const started = startWatcher();
    const file = await addAndWaitForLoad(skillsDir, 'before-rename');
    // The rename unloads the old name first; this listener stops the watcher then.
    started.on('unloaded', () => {
      void started.stop();
    });

    fs.writeFileSync(file, '---\nname: after-rename\ntriggers: [after-rename]\n---\nrenamed\n');
    await waitFor(() => !started.isWatching(), 'the watcher to be stopped');
    await sleep(SETTLE_MS);

    expect(getSkillRegistry().has('after-rename')).toBe(false);
    expect(getSkillRegistry().has('before-rename')).toBe(false);
  }, 30000);

  it('leaves a registration that something else made from the same file when it is stopped', async () => {
    const started = startWatcher();
    const file = await addAndWaitForLoad(skillsDir, 'shared-file');
    // Something else loads the same file again and registers its own SkillFile.
    const replacement = await loadSkillFromFile(file);
    getSkillRegistry().register(replacement!);

    await started.stop();

    expect(getSkillRegistry().getFile('shared-file')).toBe(replacement);
    expect(names('unloaded')).toEqual([]);
  }, 30000);

  it('registers nothing when a registry listener stops it during the register', async () => {
    const started = startWatcher();
    const registry = getSkillRegistry();
    const stopOnLoad: Parameters<typeof registry.addEventListener>[0] = (event) => {
      if (event.type === 'skill:loaded' && event.name === 'stopped-in-register') {
        void started.stop();
      }
    };
    registry.addEventListener(stopOnLoad);
    try {
      writeSkillFile(skillsDir, 'stopped-in-register');
      await waitFor(() => !started.isWatching(), 'the watcher to be stopped');
      await sleep(SETTLE_MS);

      expect(registry.has('stopped-in-register')).toBe(false);
      expect(names('loaded')).toEqual([]);
    } finally {
      registry.removeEventListener(stopOnLoad);
    }
  }, 30000);

  it('does not overwrite a skill that a registry listener registers under the name during a reload', async () => {
    startWatcher();
    const file = path.resolve(await addAndWaitForLoad(skillsDir, 'report'));
    const registry = getSkillRegistry();
    const codePath = path.join(skillsDir, 'report.js');
    const code = codeSkillFile(codePath, 'report', ['code-only']);
    let hasTakenName = false;
    // Takes the name when the reload drops the Markdown version.
    const takeName: Parameters<typeof registry.addEventListener>[0] = (event) => {
      if (event.type === 'skill:unloaded' && event.name === 'report' && !hasTakenName) {
        hasTakenName = true;
        registry.register(code);
      }
    };
    registry.addEventListener(takeName);
    try {
      writeSkillFile(skillsDir, 'report', 'a longer body than before');
      await waitFor(
        () => names('reloaded').includes('report') || errorsFor(file).length > 0,
        "'reloaded' or an 'error' for report.skill.md"
      );

      expect(hasTakenName).toBe(true);
      expect(registry.getFile('report')).toBe(code);
      expect(registry.findByTrigger('code-only')).toEqual([code.skill]);
      expect(registry.findByTrigger('report')).toEqual([]);
      expect(names('reloaded')).toEqual([]);
      expect(names('unloaded')).toEqual(['report']);
      expect(errorsFor(file).join('\n')).toContain(codePath);
    } finally {
      registry.removeEventListener(takeName);
    }
  }, 30000);

  it('does not overwrite what a registry listener registers from the same file during a rename', async () => {
    startWatcher();
    const file = path.resolve(await addAndWaitForLoad(skillsDir, 'first-title'));
    const registry = getSkillRegistry();
    const fromListener = codeSkillFile(file, 'second-title', ['listener-only']);
    let hasRegistered = false;
    // Registers the new name from the same file when the rename drops the old one.
    const registerNewName: Parameters<typeof registry.addEventListener>[0] = (event) => {
      if (event.type === 'skill:unloaded' && event.name === 'first-title' && !hasRegistered) {
        hasRegistered = true;
        registry.register(fromListener);
      }
    };
    registry.addEventListener(registerNewName);
    try {
      fs.writeFileSync(file, '---\nname: second-title\ntriggers: [second-title]\n---\nrenamed\n');
      await waitFor(
        () => names('reloaded').includes('second-title') || errorsFor(file).length > 0,
        "'reloaded' or an 'error' for the renamed file"
      );

      expect(hasRegistered).toBe(true);
      expect(registry.getFile('second-title')).toBe(fromListener);
      expect(registry.findByTrigger('listener-only')).toEqual([fromListener.skill]);
      expect(names('reloaded')).toEqual([]);
      expect(names('unloaded')).toEqual(['first-title']);
    } finally {
      registry.removeEventListener(registerNewName);
    }
  }, 30000);

  it('unloads its own skill when a renamed file is deleted, and leaves what a listener registered from it', async () => {
    startWatcher();
    const file = path.resolve(await addAndWaitForLoad(skillsDir, 'first-title'));
    const registry = getSkillRegistry();
    const fallback = codeSkillFile(file, 'fallback-title', ['fallback-title']);
    // Registers another name from the same file when the rename drops the old one.
    const registerFallback: Parameters<typeof registry.addEventListener>[0] = (event) => {
      if (event.type === 'skill:unloaded' && event.name === 'first-title' && !registry.has('fallback-title')) {
        registry.register(fallback);
      }
    };
    registry.addEventListener(registerFallback);
    try {
      fs.writeFileSync(file, '---\nname: second-title\ntriggers: [second-title]\n---\nrenamed\n');
      await waitFor(() => names('reloaded').includes('second-title'), "'reloaded' for second-title");
      fs.rmSync(file);
      await waitFor(() => names('unloaded').includes('second-title'), "'unloaded' for second-title");

      expect(registry.has('second-title')).toBe(false);
      expect(registry.getFile('fallback-title')).toBe(fallback);
    } finally {
      registry.removeEventListener(registerFallback);
    }
  }, 30000);

  it('neither unloads nor runs the hooks of a skill something else registered from a deleted file', async () => {
    const started = startWatcher();
    const registry = getSkillRegistry();
    const file = path.join(skillsDir, 'hooked.skill.md');
    const replacement = codeSkillFile(path.join(skillsDir, 'other.js'), 'hooked', ['hooked']);
    const hooked = codeSkillFile(file, 'hooked', ['hooked']);
    let unloadHookCalls = 0;
    // While this hook runs, another file takes the name.
    hooked.skill.onUnload = async () => {
      unloadHookCalls += 1;
      registry.register(replacement);
    };
    registry.register(hooked);

    const handlers = started as unknown as { handleFileUnlink(file: string): void };
    handlers.handleFileUnlink(file);
    await sleep(100);

    expect(unloadHookCalls).toBe(0);
    expect(registry.getFile('hooked')).toBe(hooked);
    expect(names('unloaded')).toEqual([]);
  }, 30000);

  it('does not replace a skill with hooks that something else registered from the same file', async () => {
    startWatcher();
    const registry = getSkillRegistry();
    const file = path.join(skillsDir, 'hooked-here.skill.md');
    const hooked = codeSkillFile(file, 'hooked-here', ['hooked-here']);
    let unloadHookCalls = 0;
    hooked.skill.onUnload = async () => {
      unloadHookCalls += 1;
    };
    registry.register(hooked);

    writeSkillFile(skillsDir, 'hooked-here');
    await waitFor(() => errorsFor(file).length > 0, "an 'error' for hooked-here.skill.md");

    expect(registry.getFile('hooked-here')).toBe(hooked);
    expect(unloadHookCalls).toBe(0);
    expect(names('loaded')).toEqual([]);
  }, 30000);

  // On Windows a backslash is a separator, so these names cannot be made there.
  (process.platform === 'win32' ? it.skip : it)(
    'loads no file whose name has a backslash in it',
    async () => {
      const writeNamed = (fileName: string, name: string): void => {
        fs.writeFileSync(path.join(skillsDir, fileName), `---\nname: ${name}\ntriggers: [${name}]\n---\nbody\n`);
      };
      startWatcher({ patterns: ['team/**/*.skill.md', '*.skill.md'] });
      writeNamed('team\\daily.skill.md', 'slash-team');
      writeNamed('.disabled\\daily.skill.md', 'slash-disabled');
      writeNamed('a\\b.skill.md', 'slash-plain');
      await addAndWaitForLoad(skillsDir, 'kept-skill');
      await sleep(SETTLE_MS);

      expect(names('loaded')).toEqual(['kept-skill']);
      for (const name of ['slash-team', 'slash-disabled', 'slash-plain']) {
        expect(getSkillRegistry().has(name)).toBe(false);
      }
    },
    30000
  );

  (process.platform === 'win32' ? it.skip : it)(
    'refuses a skills directory with a backslash in its path, before creating it',
    () => {
      skillsDir = path.join(tempRoot, 'team\\one');
      const created = new SkillWatcher({ skillsDir, debounceMs: 20 });

      expect(() => created.start()).toThrow('backslash');
      expect(created.isWatching()).toBe(false);
      expect(fs.existsSync(skillsDir)).toBe(false);
    }
  );

  it('does not report or own a load that a registry listener replaces during the register', async () => {
    const started = startWatcher();
    const registry = getSkillRegistry();
    const codePath = path.join(skillsDir, 'replaced.js');
    const code = codeSkillFile(codePath, 'replaced', ['replaced']);
    const replaceOnLoad: Parameters<typeof registry.addEventListener>[0] = (event) => {
      if (event.type === 'skill:loaded' && event.name === 'replaced' && event.path !== codePath) {
        registry.register(code);
      }
    };
    registry.addEventListener(replaceOnLoad);
    try {
      writeSkillFile(skillsDir, 'replaced');
      await waitFor(() => registry.getFile('replaced') === code, 'the code skill to replace it');
      await sleep(SETTLE_MS);
      await started.stop();

      expect(names('loaded')).toEqual([]);
      expect(registry.getFile('replaced')).toBe(code);
    } finally {
      registry.removeEventListener(replaceOnLoad);
    }
  }, 30000);

  it('leaves a registration that an error listener makes while it refuses a linked file', async () => {
    const outside = path.join(tempRoot, 'outside');
    skillsDir = path.join(tempRoot, 'skills');
    writeSkillFile(outside, 'behind-link');
    const started = startWatcher();
    expect(tryLink(outside, path.join(skillsDir, 'linked'), 'dir')).toBe(true);
    const linkedFile = path.join(skillsDir, 'linked', 'behind-link.skill.md');
    const replacement = codeSkillFile(linkedFile, 'replacement', ['replacement']);
    // On the refusal, stop the watcher and register something from that path.
    started.on('error', (_name, file) => {
      if (file === linkedFile && !getSkillRegistry().has('replacement')) {
        void started.stop();
        getSkillRegistry().register(replacement);
      }
    });

    const handlers = started as unknown as { loadFile(event: 'add', file: string): Promise<void> };
    await handlers.loadFile('add', linkedFile);

    expect(errorsFor(linkedFile).join('\n')).toContain('symbolic link');
    expect(getSkillRegistry().getFile('replacement')).toBe(replacement);
  }, 30000);

  it('does not read through a skills directory that has become a link since start()', async () => {
    const otherDir = path.join(tempRoot, 'other');
    const linkedRoot = path.join(tempRoot, 'now-a-link');
    writeSkillFile(otherDir, 'from-other');
    expect(tryLink(otherDir, linkedRoot, 'dir')).toBe(true);
    // Not started: the handler is called as a queued load would call it.
    const created = new SkillWatcher({ skillsDir: linkedRoot, debounceMs: 20 });
    created.on('error', (name, file, error) => seen.push({ event: 'error', name, file, message: error?.message }));
    const handlers = created as unknown as { loadFile(event: 'add', file: string): Promise<void> };

    const file = path.join(linkedRoot, 'from-other.skill.md');
    await handlers.loadFile('add', file);

    expect(getSkillRegistry().has('from-other')).toBe(false);
    expect(errorsFor(file).join('\n')).toContain('symbolic link');
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
