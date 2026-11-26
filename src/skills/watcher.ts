/**
 * Titan Memory Skill Watcher
 * File watcher for hot-reload of .skill.md skills using chokidar
 */

import { watch, FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { reloadSkill, unloadSkill, getDefaultSkillsDir } from './loader.js';
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

/**
 * Skill Watcher
 * Watches a skills directory and hot-reloads the .skill.md files in it.
 *
 * Code skills (.js and .ts files) are not hot-reloaded. The watcher never
 * imports a file, and the add, change or delete of a code file loads,
 * reloads and unloads nothing. Code skills are loaded by
 * loadSkillsFromDirectory() or reloadSkill(); after an edit they need a
 * call to reloadSkill() or a restart.
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
  private debounceMs: number;
  private patterns: string[];
  private ignored: string[];
  private shouldSkip: WatchFilter;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private callbacks: Map<WatcherEvent, WatcherCallback[]> = new Map();
  private isRunning = false;

  constructor(options: SkillWatcherOptions = {}) {
    this.skillsDir = options.skillsDir || getDefaultSkillsDir();
    this.debounceMs = options.debounceMs ?? 500;
    this.patterns = options.patterns || ['**/*.skill.md'];
    this.ignored = options.ignored || [
      '**/node_modules/**',
      '**/.disabled/**',
      '**/dist/**',
      '**/*.d.ts',
    ];
    const isExcludedByOptions = createWatchFilter({
      root: this.skillsDir,
      patterns: this.patterns,
      ignored: this.ignored,
    });
    // The one place that decides which paths the watcher handles. chokidar
    // asks it, and so do the event handlers before they do anything.
    this.shouldSkip = (candidatePath, stats) =>
      isExcludedByOptions(candidatePath, stats) ||
      (isFileOrLink(stats) && !isMarkdownSkillFile(candidatePath));

    if (options.autoStart) {
      this.start();
    }
  }

  /**
   * Start watching for file changes.
   *
   * Creates the skills directory when it does not exist yet, so there is
   * always a directory to watch. Throws if it cannot be created.
   *
   * The .skill.md files already in the directory are loaded as well, and
   * reported as 'loaded', as the first scan finds them. So a file is not
   * missed because it was written just before or just after start(), and a
   * restart picks up the skills that are there.
   *
   * Symbolic links below the skills directory are reported under their own
   * path and never followed, so a linked directory is not walked. A
   * .skill.md path that is a link, or is below one, when its event is
   * handled is not read: an 'error' event names it, and a skill loaded from
   * that path earlier is unloaded. See crossesSymlink for what that check
   * covers. The skills directory itself may be a link. It is resolved once,
   * here, so after the link is pointed at another directory the watcher
   * needs a stop() and start().
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    // chokidar 4 and later take paths, not globs. Watch the directory and
    // let the filter pick the files (see watch-filter.ts).
    const configuredDir = path.resolve(this.skillsDir);
    fs.mkdirSync(configuredDir, { recursive: true });
    // chokidar does not follow the watched path either when it is a link, so
    // watch the directory it leads to and report paths below skillsDir.
    const watchedDir = fs.realpathSync(configuredDir);
    const toConfiguredPath = (reportedPath: string): string =>
      path.join(configuredDir, path.relative(watchedDir, path.resolve(reportedPath)));

    this.watcher = watch(watchedDir, {
      ignored: (candidatePath, stats) => this.shouldSkip(toConfiguredPath(candidatePath), stats),
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher
      .on('add', (filePath) => this.handleFileChange('add', toConfiguredPath(filePath)))
      .on('change', (filePath) => this.handleFileChange('change', toConfiguredPath(filePath)))
      .on('unlink', (filePath) => this.handleFileUnlink(toConfiguredPath(filePath)))
      .on('error', (error) => this.emit('error', 'watcher', undefined, error as Error));

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
    if (crossesSymlink(this.skillsDir, filePath)) {
      // A link now, or below one, or deleted since the event.
      if (pathExists(filePath)) {
        const reason = `${filePath} is outside the skills directory or behind a symbolic link`;
        this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
      }
      await this.unloadFile(filePath);
      return;
    }

    const previousName = this.findSkillName(filePath);
    const skillFile = await reloadSkill(filePath);
    const newName = skillFile?.metadata.name;

    // reloadSkill unregistered the old version. Its name is gone when the new
    // version did not load or has another name, unless another file has
    // registered a skill under that name since.
    if (previousName && previousName !== newName && !getSkillRegistry().has(previousName)) {
      this.emit('unloaded', previousName, filePath);
    }
    if (newName) {
      this.emit(eventType === 'add' ? 'loaded' : 'reloaded', newName, filePath);
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
