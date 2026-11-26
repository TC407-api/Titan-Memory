/**
 * Titan Memory Skill Watcher
 * File watcher for hot-reload of .skill.md skills using chokidar
 */

import { watch, FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { loadSkillFromFile, unloadSkill, getDefaultSkillsDir } from './loader.js';
import { getSkillRegistry } from './registry.js';
import type { SkillFile } from './types.js';
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

/** One load of a file, as it stood before any listener ran. */
interface FileLoad {
  eventType: 'add' | 'change';
  filePath: string;
  /** The run the load was started in. */
  generation: number;
  /** What was registered from this file under the new name, if anything. */
  replaced?: SkillFile;
}

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
 * loadSkillsFromDirectory() or reloadSkill(). After an edit a code skill
 * needs a restart: Node keeps serving a CommonJS file from its module cache,
 * so reloadSkill() picks up an edited ES module file only.
 *
 * A .skill.md file whose skill name is already registered from another file
 * (a code skill, or another .skill.md file) is not loaded and does not
 * replace that skill: an 'error' event names the other file. It is loaded
 * on its next change after the name has become free.
 *
 * Listeners, the watcher's and the registry's, run during loads and
 * unloads, and can stop the watcher or register skills. After each registry
 * call and each event it emits, the watcher checks the run and the registry
 * again before it changes anything, so it does not undo or overwrite what a
 * listener registered.
 *
 * The skills the watcher registers exist while it runs: start() loads the
 * .skill.md files that are there, and stop() unloads what the watcher
 * registered. So nothing it loaded outlives a file that was deleted or
 * replaced while it was stopped. A registration something else made since
 * (from the same file, or under the same name) is left alone, and a load
 * that is still running when stop() is called registers nothing.
 *
 * File paths are compared as strings, spelled as the watcher reports them
 * (below skillsDir as given), as the loader and the registry do. A skill
 * registered from another spelling of the same file (other letter case,
 * or through a link) counts as registered from another file.
 *
 * The paths are read when an event is handled. After a link on the path to
 * skillsDir is pointed elsewhere, call stop() and start(): stop() unloads
 * what the watcher loaded and start() loads what is there now.
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
  // skillsDir as an absolute path, spelled as given: the one spelling used
  // for watching, filtering, reading and the registry.
  private root: string;
  private debounceMs: number;
  private patterns: string[];
  private ignored: string[];
  private shouldSkip: WatchFilter;
  // Pending loads by file path, with the event they will report.
  private debounceTimers: Map<string, { timer: NodeJS.Timeout; eventType: 'add' | 'change' }> =
    new Map();
  private callbacks: Map<WatcherEvent, WatcherCallback[]> = new Map();
  // What this watcher has registered, by file path. See stop().
  private ownedFiles: Map<string, SkillFile> = new Map();
  private isRunning = false;
  // Changes with every start() and stop(), so a load can tell that the run
  // it was started in has ended.
  private generation = 0;

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
   * The .skill.md files already in the directory are loaded too, and
   * reported as 'loaded', as the first scan finds them. So a file written
   * just before or just after start() is not missed.
   *
   * Symbolic links below the skills directory are reported under their own
   * path and never followed, so a linked directory is not walked. A
   * .skill.md path that is a link, or is below one, when its event is
   * handled is not read: an 'error' event names it, and a skill loaded from
   * that path earlier is unloaded. See crossesSymlink for what that check
   * covers.
   *
   * The skills directory itself must not be a link: start() throws if it
   * is. Pass the directory the link points to. A link further up the path
   * is fine.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    // chokidar 4 and later take paths, not globs. Watch the directory and
    // let the filter pick the files (see watch-filter.ts).
    fs.mkdirSync(this.root, { recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink()) {
      throw new Error(
        `Skills directory ${this.root} is a symbolic link; watch the directory it points to`
      );
    }

    this.watcher = watch(this.root, {
      ignored: this.shouldSkip,
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
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

    this.generation += 1;
    this.isRunning = true;
  }

  /**
   * Stop watching for file changes. Loads that are still waiting for their
   * debounce are dropped, and file events that arrive from now on are
   * ignored.
   *
   * The skills this watcher registered are unloaded, each reported as
   * 'unloaded', before stop() first waits: while nothing watches their
   * files, nothing could unload them when a file goes. A skill registered by
   * anything else stays. A start() loads the files that are there again.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.watcher) {
      return;
    }

    const closing = this.watcher;
    this.watcher = null;
    this.isRunning = false;
    this.generation += 1;

    // Clear all pending debounce timers
    for (const { timer } of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.unloadOwnedSkills();

    await closing.close();
  }

  /**
   * Unregister each skill this watcher registered that is still registered
   * as it left it (the same SkillFile). A registration that something else
   * has made since, from the same file or under the same name, stays.
   * Synchronous: such a skill has no onUnload() hook.
   */
  private unloadOwnedSkills(): void {
    const registry = getSkillRegistry();
    const owned = [...this.ownedFiles.values()];
    this.ownedFiles.clear();
    for (const skillFile of owned) {
      const name = skillFile.metadata.name;
      if (registry.getFile(name) === skillFile && registry.unregister(name)) {
        this.emit('unloaded', name, skillFile.path);
      }
    }
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

    // Clear existing timer for this file. A file added and then changed
    // before its load ran is still loaded as added.
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const pendingType = existing?.eventType === 'add' ? 'add' : eventType;

    // Set new debounced timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.runReportingErrors(filePath, () => this.loadFile(pendingType, filePath));
    }, this.debounceMs);

    this.debounceTimers.set(filePath, { timer, eventType: pendingType });
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
      clearTimeout(existing.timer);
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
      // A link now, or below one, or deleted since the event. Unloaded before
      // the 'error' is emitted, so nothing a listener does then is undone.
      const isPresent = pathExists(filePath);
      await this.unloadFile(filePath);
      if (isPresent) {
        const reason = `${filePath} is outside the skills directory or behind a symbolic link`;
        this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
      }
      return;
    }

    // A stop() (from a listener, say) while this load waits ends its run.
    const generation = this.generation;
    const skillFile = await loadSkillFromFile(filePath);
    if (generation !== this.generation) {
      return;
    }
    // What this load may replace, taken before any listener runs: the
    // version registered from this file under the new name.
    const registered = skillFile ? getSkillRegistry().getFile(skillFile.metadata.name) : undefined;
    const replaced = registered?.path === filePath ? registered : undefined;
    // The version registered from this file before goes when the new one did
    // not load or has another name.
    const previousName = this.findSkillName(filePath);
    if (previousName && previousName !== skillFile?.metadata.name) {
      await this.unloadFile(filePath);
    }
    if (skillFile && generation === this.generation) {
      this.registerUnlessTaken(skillFile, { eventType, filePath, generation, replaced });
    }
  }

  /**
   * Register `skillFile` unless its name is registered from another file.
   *
   * The version this load replaces (`load.replaced`, taken before any
   * listener ran) is unregistered first, here, so that register() replaces
   * nothing: when it replaces a skill, register() runs registry listeners
   * between its own check and its update. Each registry call can run
   * listeners, which can stop the watcher or register the name, from any
   * file. So both are checked again after each call, and what a listener
   * registered is left alone.
   */
  private registerUnlessTaken(skillFile: SkillFile, load: FileLoad): void {
    const { eventType, filePath, generation } = load;
    const registry = getSkillRegistry();
    const name = skillFile.metadata.name;
    const hasDroppedPrevious = this.dropRegistered(load.replaced);
    const owner = registry.getFile(name);
    if (owner || generation !== this.generation) {
      if (hasDroppedPrevious) this.emit('unloaded', name, filePath);
      if (owner) {
        const reason = `the name "${name}" is registered from ${owner.path}`;
        this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
      }
      return;
    }
    registry.register(skillFile);
    if (registry.getFile(name) !== skillFile) {
      return; // A registry listener replaced or removed it during the register.
    }
    if (generation !== this.generation) {
      registry.unregister(name);
      return;
    }
    this.ownedFiles.set(filePath, skillFile);
    this.emit(eventType === 'add' ? 'loaded' : 'reloaded', name, filePath);
  }

  /** Unregister `skillFile` if it is still the one registered under its name. True when it was. */
  private dropRegistered(skillFile: SkillFile | undefined): boolean {
    const registry = getSkillRegistry();
    if (!skillFile || registry.getFile(skillFile.metadata.name) !== skillFile) {
      return false;
    }
    this.ownedFiles.delete(skillFile.path);
    return registry.unregister(skillFile.metadata.name);
  }

  /** Unload the skill that was loaded from `filePath`, if there is one. */
  private async unloadFile(filePath: string): Promise<void> {
    this.ownedFiles.delete(filePath);
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
