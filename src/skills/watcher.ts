/**
 * Titan Memory Skill Watcher
 * File watcher for hot-reload of .skill.md skills using chokidar
 */

import { watch, FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { loadSkillFromFile, unloadSkill, getDefaultSkillsDir } from './loader.js';
import { getSkillRegistry } from './registry.js';
import {
  createWatchFilter,
  crossesSymlink,
  isFileOrLink,
  isMarkdownSkillFile,
  PathKind,
  WatchFilter,
} from './watch-filter.js';
// SkillEvent and SkillEventListener imported for type reference only

export interface SkillWatcherOptions {
  /** Directory to watch for skills */
  skillsDir?: string;
  /** Debounce delay in ms (default: 500) */
  debounceMs?: number;
  /**
   * Globs for the files to report, relative to skillsDir
   * (default: any .skill.md file at any depth). They can narrow that set
   * and cannot widen it: a file that is not a .skill.md file is never
   * reported, also when a pattern matches it.
   * See globToRegExp in watch-filter.ts for the supported syntax.
   */
  patterns?: string[];
  /**
   * Globs for files and directories to skip. A relative glob is matched
   * below skillsDir only; an absolute glob is matched against the full path.
   */
  ignored?: string[];
  /** Auto-start watching */
  autoStart?: boolean;
}

type WatcherEvent = 'loaded' | 'unloaded' | 'reloaded' | 'error';
type WatcherCallback = (name: string, path?: string, error?: Error) => void;

/** Stands in for fs.Stats when a path is already known to be a file. */
const FILE_KIND: PathKind = { isFile: () => true };

/** True when something (a file, a directory, a link, even a broken one) is at `filePath`. */
function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** True when `candidatePath` is below `root` (not `root` itself). */
function isBelow(root: string, candidatePath: string): boolean {
  const relativePath = path.relative(root, candidatePath);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

/**
 * Skill Watcher
 * Watches a skills directory and hot-reloads the .skill.md files in it.
 *
 * Code skills (.js and .ts files) are not hot-reloaded. The watcher never
 * imports a file, and the add, change or delete of a code file loads,
 * reloads and unloads nothing. Code skills are loaded by
 * loadSkillsFromDirectory() or reloadSkill(). After an edit a code skill
 * needs a restart: Node keeps serving a CommonJS file from its module cache,
 * so reloadSkill() picks up an edited ES module file only.
 *
 * A .skill.md file whose skill name is already registered from another file
 * (a code skill, or another .skill.md file) is not loaded and does not
 * replace that skill: an 'error' event names the other file. It is loaded
 * on its next change after the name has become free.
 *
 * A skill the loader builds from a .skill.md file has no onLoad() or
 * onUnload() hook, and reading the file is synchronous. So each load or
 * unload the watcher starts is finished before the next file event is
 * handled, and the loads and unloads of a file happen in the order of its
 * events.
 */
export class SkillWatcher {
  private watcher: FSWatcher | null = null;
  private skillsDir: string;
  // The directory that is watched and read: skillsDir, with links resolved
  // by start().
  private root: string;
  private debounceMs: number;
  private patterns: string[];
  private ignored: string[];
  private shouldSkip: WatchFilter;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private callbacks: Map<WatcherEvent, WatcherCallback[]> = new Map();
  private isRunning = false;

  constructor(options: SkillWatcherOptions = {}) {
    this.skillsDir = options.skillsDir || getDefaultSkillsDir();
    this.root = path.resolve(this.skillsDir);
    this.debounceMs = options.debounceMs ?? 500;
    this.patterns = options.patterns || ['**/*.skill.md'];
    this.ignored = options.ignored || [
      '**/node_modules/**',
      '**/.disabled/**',
      '**/dist/**',
      '**/*.d.ts',
    ];
    this.shouldSkip = this.createFilter();

    if (options.autoStart) {
      this.start();
    }
  }

  /**
   * The one place that decides which paths below `root` the watcher handles.
   * chokidar asks it, and so do the event handlers before they do anything.
   */
  private createFilter(): WatchFilter {
    const isExcludedByOptions = createWatchFilter({
      root: this.root,
      patterns: this.patterns,
      ignored: this.ignored,
    });
    return (candidatePath, stats) =>
      isExcludedByOptions(candidatePath, stats) ||
      (isFileOrLink(stats) && !isMarkdownSkillFile(candidatePath));
  }

  /**
   * Start watching for file changes.
   *
   * Creates the skills directory when it does not exist yet, so there is
   * always a directory to watch. Throws if it cannot be created.
   *
   * start() brings the registry in line with the directory. The .skill.md
   * files already there are loaded, and reported as 'loaded', as the first
   * scan finds them, so a file written just before or just after start() is
   * not missed. When that scan is done, a .skill.md skill registered from a
   * file below the directory that no longer exists (deleted while the
   * watcher was stopped) is unloaded.
   *
   * Symbolic links below the skills directory are reported under their own
   * path and never followed, so a linked directory is not walked. A
   * .skill.md path that is a link, or is below one, when its event is
   * handled is not read: an 'error' event names it, and a skill loaded from
   * that path earlier is unloaded. See crossesSymlink for what that check
   * covers.
   *
   * The skills directory itself may be a link. start() resolves it, and the
   * watcher watches and reads the directory it pointed to then, so paths in
   * events and in the registry are below that directory. After the link is
   * pointed elsewhere, a stop() and start() moves the watcher to the new one.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    // chokidar 4 and later take paths, not globs. Watch the directory and
    // let the filter pick the files (see watch-filter.ts). chokidar does not
    // follow the watched path when it is a link, so resolve it here.
    fs.mkdirSync(path.resolve(this.skillsDir), { recursive: true });
    this.root = fs.realpathSync(path.resolve(this.skillsDir));
    this.shouldSkip = this.createFilter();

    const watcher = watch(this.root, {
      ignored: this.shouldSkip,
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    watcher
      .on('add', (filePath) => this.handleFileChange('add', filePath))
      .on('change', (filePath) => this.handleFileChange('change', filePath))
      .on('unlink', (filePath) => this.handleFileUnlink(filePath))
      .on('ready', () => {
        if (this.watcher === watcher) this.unloadMissingFiles();
      })
      .on('error', (error) => this.emit('error', 'watcher', undefined, error as Error));

    this.watcher = watcher;
    this.isRunning = true;
  }

  /**
   * Stop watching for file changes. Loads that are still waiting for their
   * debounce are dropped, and file events that arrive from now on are
   * ignored.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.watcher) {
      return;
    }

    const closing = this.watcher;
    this.watcher = null;
    this.isRunning = false;

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    await closing.close();
  }

  /**
   * Check if watcher is running
   */
  isWatching(): boolean {
    return this.isRunning;
  }

  /**
   * Register event callback
   */
  on(event: WatcherEvent, callback: WatcherCallback): void {
    if (!this.callbacks.has(event)) {
      this.callbacks.set(event, []);
    }
    this.callbacks.get(event)!.push(callback);
  }

  /**
   * Remove event callback
   */
  off(event: WatcherEvent, callback: WatcherCallback): void {
    const callbacks = this.callbacks.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index >= 0) {
        callbacks.splice(index, 1);
      }
    }
  }

  /**
   * Handle file add/change events with debouncing
   */
  private handleFileChange(eventType: 'add' | 'change', reportedPath: string): void {
    const filePath = path.resolve(reportedPath);
    if (!this.isRunning || this.shouldSkip(filePath, FILE_KIND)) {
      return;
    }

    // Clear existing timer for this file
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounced timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.runReportingErrors(filePath, () => this.loadFile(eventType, filePath));
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Handle file deletion
   */
  private handleFileUnlink(reportedPath: string): void {
    const filePath = path.resolve(reportedPath);
    if (!this.isRunning || this.shouldSkip(filePath, FILE_KIND)) {
      return;
    }

    // Clear any pending debounce timer
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(filePath);
    }

    this.runReportingErrors(filePath, () => this.unloadFile(filePath));
  }

  /** Run a load or unload of `filePath`, and report a failure as an 'error' event. */
  private runReportingErrors(filePath: string, operation: () => Promise<void>): void {
    operation().catch((error: unknown) => {
      this.emit('error', filePath, filePath, error as Error);
    });
  }

  /** Load or reload the skill in `filePath` and report what happened. */
  private async loadFile(eventType: 'add' | 'change', filePath: string): Promise<void> {
    if (crossesSymlink(this.root, filePath)) {
      // A link now, or below one, or deleted since the event.
      if (pathExists(filePath)) {
        const reason = `${filePath} is outside the skills directory or behind a symbolic link`;
        this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
      }
      await this.unloadFile(filePath);
      return;
    }

    const skillFile = await loadSkillFromFile(filePath);
    // The version registered from this file before goes when the new one did
    // not load or has another name.
    const previousName = this.findSkillName(filePath);
    if (previousName && previousName !== skillFile?.metadata.name) {
      await this.unloadFile(filePath);
    }
    if (!skillFile) {
      return;
    }

    // Checked right before the register, with no await in between.
    const registry = getSkillRegistry();
    const owner = registry.getFile(skillFile.metadata.name);
    if (owner && owner.path !== filePath) {
      const reason = `the name "${skillFile.metadata.name}" is registered from ${owner.path}`;
      this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
      return;
    }
    registry.register(skillFile);
    this.emit(eventType === 'add' ? 'loaded' : 'reloaded', skillFile.metadata.name, filePath);
  }

  /**
   * Unload the .skill.md skills registered from files below the watched
   * directory that no longer exist. Run when the first scan is done: a file
   * deleted while the watcher was stopped gets no event.
   */
  private unloadMissingFiles(): void {
    const registry = getSkillRegistry();
    for (const metadata of registry.list()) {
      const filePath = registry.getFile(metadata.name)?.path;
      if (
        filePath !== undefined &&
        isBelow(this.root, filePath) &&
        !this.shouldSkip(filePath, FILE_KIND) &&
        !pathExists(filePath)
      ) {
        this.runReportingErrors(filePath, () => this.unloadFile(filePath));
      }
    }
  }

  /** Unload the skill that was loaded from `filePath`, if there is one. */
  private async unloadFile(filePath: string): Promise<void> {
    const name = this.findSkillName(filePath);
    if (name && (await unloadSkill(name))) {
      this.emit('unloaded', name, filePath);
    }
  }

  /** Name of the registered skill that was loaded from `filePath`. */
  private findSkillName(filePath: string): string | undefined {
    const registry = getSkillRegistry();
    return registry.list().find((metadata) => registry.getFile(metadata.name)?.path === filePath)
      ?.name;
  }

  /**
   * Emit event to callbacks
   */
  private emit(
    event: WatcherEvent,
    name: string,
    filePath?: string,
    error?: Error
  ): void {
    const callbacks = this.callbacks.get(event) || [];
    for (const callback of callbacks) {
      try {
        callback(name, filePath, error);
      } catch (err) {
        console.warn('Skill watcher callback error:', err);
      }
    }
  }

  /**
   * Get watched directory
   */
  getWatchedDirectory(): string {
    return this.skillsDir;
  }
}

// Singleton instance
let watcherInstance: SkillWatcher | null = null;

export function getSkillWatcher(options?: SkillWatcherOptions): SkillWatcher {
  if (!watcherInstance) {
    watcherInstance = new SkillWatcher(options);
  }
  return watcherInstance;
}

export function resetSkillWatcher(): void {
  if (watcherInstance) {
    watcherInstance.stop();
  }
  watcherInstance = null;
}
