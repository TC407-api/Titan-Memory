/**
 * Titan Memory Skill Watcher
 * File watcher for hot-reload of skills using chokidar
 */

import { watch, FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { reloadSkill, unloadSkill, getDefaultSkillsDir } from './loader.js';
import { getSkillRegistry } from './registry.js';
import { createWatchFilter, crossesSymlink, PathKind, WatchFilter } from './watch-filter.js';
// SkillEvent and SkillEventListener imported for type reference only

export interface SkillWatcherOptions {
  /** Directory to watch for skills */
  skillsDir?: string;
  /** Debounce delay in ms (default: 500) */
  debounceMs?: number;
  /**
   * Globs for the files to report, relative to skillsDir
   * (default: any .ts, .js or .skill.md file at any depth).
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

/**
 * Skill Watcher
 * Watches skill directories and hot-reloads on changes
 */
export class SkillWatcher {
  private watcher: FSWatcher | null = null;
  private skillsDir: string;
  private debounceMs: number;
  private patterns: string[];
  private ignored: string[];
  private shouldSkip: WatchFilter;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  // The last load or unload queued for each file. See enqueue().
  private operations: Map<string, Promise<void>> = new Map();
  private callbacks: Map<WatcherEvent, WatcherCallback[]> = new Map();
  private isRunning = false;

  constructor(options: SkillWatcherOptions = {}) {
    this.skillsDir = options.skillsDir || getDefaultSkillsDir();
    this.debounceMs = options.debounceMs ?? 500;
    this.patterns = options.patterns || ['**/*.ts', '**/*.js', '**/*.skill.md'];
    this.ignored = options.ignored || [
      '**/node_modules/**',
      '**/.disabled/**',
      '**/dist/**',
      '**/*.d.ts',
    ];
    this.shouldSkip = createWatchFilter({
      root: this.skillsDir,
      patterns: this.patterns,
      ignored: this.ignored,
    });

    if (options.autoStart) {
      this.start();
    }
  }

  /**
   * Start watching for file changes.
   *
   * Creates the skills directory when it does not exist yet, so there is
   * always a directory to watch (chokidar 4 reports nothing for a path that
   * is missing when watch() is called). Throws if it cannot be created.
   *
   * Symbolic links below the skills directory are not followed, the same as
   * in loadSkillsFromDirectory. The skills directory itself may be a link.
   * A file is loaded only when it, and for a .ts file also the compiled .js
   * file whose content is used, is below the skills directory and not
   * behind a link. Otherwise nothing is read and an 'error' event names the
   * path. So a .ts file whose compiled file is in a dist directory outside
   * the skills directory is not hot-reloaded.
   *
   * Loads and unloads of one file run one after the other, in the order
   * their file events arrived, so a file deleted while its load is still
   * running (a slow onLoad()) ends up unloaded.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    // chokidar 4 and later take paths, not globs. Watch the directory and
    // let the filter pick the files (see watch-filter.ts).
    const watchedDir = path.resolve(this.skillsDir);
    fs.mkdirSync(watchedDir, { recursive: true });

    this.watcher = watch(watchedDir, {
      ignored: this.shouldSkip,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher
      .on('add', (filePath) => this.handleFileChange('add', filePath))
      .on('change', (filePath) => this.handleFileChange('change', filePath))
      .on('unlink', (filePath) => this.handleFileUnlink(filePath))
      .on('error', (error) => this.emit('error', 'watcher', undefined, error as Error));

    this.isRunning = true;
  }

  /**
   * Stop watching for file changes.
   *
   * File events that arrive from now on are ignored. stop() does not wait
   * for skill code: a load or unload that was already queued for an earlier
   * event still runs to its end, and still reports its event, after stop()
   * has returned.
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
      this.enqueue(filePath, () => this.loadFile(eventType, filePath));
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

    this.enqueue(filePath, () => this.unloadFile(filePath));
  }

  /**
   * Run `operation` once every operation queued earlier for the same file
   * has finished. Without this a delete that arrives while a load is still
   * running finds nothing to unload, and the load then registers a skill
   * whose file is gone. An onLoad() or onUnload() that never settles holds
   * back the later operations for its own file only.
   */
  private enqueue(filePath: string, operation: () => Promise<void>): void {
    const earlier = this.operations.get(filePath) ?? Promise.resolve();
    const current: Promise<void> = earlier.then(async () => {
      try {
        await operation();
      } catch (error) {
        this.emit('error', filePath, filePath, error as Error);
      }
      if (this.operations.get(filePath) === current) {
        this.operations.delete(filePath);
      }
    });
    this.operations.set(filePath, current);
  }

  /** Load or reload the skill in `filePath` and report what happened. */
  private async loadFile(eventType: 'add' | 'change', filePath: string): Promise<void> {
    const previousName = this.findSkillName(filePath);
    const skillFile = await reloadSkill(filePath, {
      allowLoadPath: (loadPath) => this.allowLoadPath(filePath, loadPath),
    });

    if (skillFile) {
      const eventName = eventType === 'add' ? 'loaded' : 'reloaded';
      this.emit(eventName, skillFile.metadata.name, filePath);
    } else if (previousName) {
      // reloadSkill unregistered the old version and the new one did not load.
      this.emit('unloaded', previousName, filePath);
    }
  }

  /** Unload the skill that was loaded from `filePath`, if there is one. */
  private async unloadFile(filePath: string): Promise<void> {
    const name = this.findSkillName(filePath);
    if (name && (await unloadSkill(name))) {
      this.emit('unloaded', name, filePath);
    }
  }

  /**
   * Asked by the loader about the file it is about to read or import
   * (`loadPath`: for a .ts file its compiled file, otherwise `filePath`
   * itself). Checked there, right before the load, and for both paths:
   * loading a file that is outside skillsDir or behind a link would run code
   * from outside the skills directory.
   */
  private allowLoadPath(filePath: string, loadPath: string): boolean {
    const refused = [filePath, loadPath].find((candidate) =>
      crossesSymlink(this.skillsDir, candidate)
    );
    if (refused === undefined) {
      return true;
    }
    const reason = `${refused} is outside the skills directory or behind a symbolic link`;
    this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
    return false;
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
