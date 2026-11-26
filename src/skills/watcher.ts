/**
 * Titan Memory Skill Watcher
 * File watcher for hot-reload of .skill.md skills using chokidar
 */

import { watch, FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { loadSkillFromFile, getDefaultSkillsDir } from './loader.js';
import { getSkillRegistry, SkillDisable, SkillRegistry } from './registry.js';
import type { SkillFile } from './types.js';
import {
  createWatchFilter,
  hasBackslashInName,
  inspectPath,
  isFileOrLink,
  isMarkdownSkillFile,
  PathKind,
  PathState,
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

/** The watcher's disabled skill from a file, as the watcher unregistered it. */
interface UnloadRecord {
  name: string;
  /** The registry's id of the disable that was in force (getDisable()). */
  disableId: number;
}

/** Stands in for fs.Stats when a path is already known to be a file. */
const FILE_KIND: PathKind = { isFile: () => true };

/**
 * How often a running watcher checks the files of the skills it loaded and
 * the files it refused, for what file events can miss (see reconcile()).
 */
const RECONCILE_INTERVAL_MS = 1000;

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
 * replace that skill: an 'error' event names the other file. The watcher
 * loads it once the name is free, whatever freed it (a file that was
 * deleted, or an unregister from elsewhere): within a second, when it
 * checks its files (see reconcile()), or on the file's next change. While
 * the name stays taken it is not tried again, so the 'error' is not
 * repeated.
 *
 * Disabled skills: the registry keeps a disable per skill name (see
 * SkillRegistry.register()), so a reload under the same name stays
 * disabled. When the watcher's skill from a file was disabled as it was
 * unregistered, and the watcher next registers a skill from that file under
 * another name (an edit, also after a broken save, a delete and re-add of
 * the file, or stop() and start()), the new skill is disabled too. This
 * happens only while that same disable is in force (see
 * SkillRegistry.getDisable()): after an enable() of the old name, a later
 * disable of it, from any file, does not carry over. When the disable was
 * made for this file's skill, it moves: the old name is enabled again,
 * unless a skill is registered under it. When the file was disabled only
 * because it took over a disabled name, the disable is copied and the old
 * name stays disabled. A registration that carried a disable but did not
 * stand (the watcher was stopped, or a listener removed it) takes back the
 * disable it made, and leaves the old name as it was.
 *
 * The watcher unloads only skills it loaded: when a file is deleted, broken,
 * renamed inside or replaced by a link, and on stop(). Each unload removes
 * one exact SkillFile, and only while it is still the one registered under
 * its name. A skill that anything else registered, from the same file too,
 * stays. The one exception is a load that replaces the skill registered
 * under the same name from the same file (the watcher's earlier version, or
 * one registered before start()); a skill with an onLoad() or onUnload()
 * hook is never replaced, as the watcher runs no hooks.
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
 * On POSIX a name below skillsDir that contains a backslash is never
 * loaded, and start() throws for a skillsDir whose path contains one:
 * chokidar reads the backslash as a separator (see hasBackslashInName).
 *
 * File events can be missed: chokidar 6 reports nothing for a file that is
 * replaced by a directory faster than it looks again, as it keeps the name
 * as a known entry. So while it runs the watcher also checks, every second,
 * that each skill it loaded still comes from a regular file reached
 * without a link (see reconcile()), and unloads one that does not. A path
 * that cannot be checked (an error other than a missing entry) is not
 * taken for gone: that check leaves the skill and looks again on its next
 * pass. A file event for such a path unloads the skill, as its new content
 * cannot be read safely, and the watcher loads the file again once the
 * path can be checked.
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
  // For each file whose skill the watcher unregistered while it was
  // disabled: its name and the disable id then in force. Kept, also through
  // stop(), until the watcher next registers a skill from that file, so that
  // a disable can follow the file to a new skill name (see carryDisable()).
  private lastUnloaded: Map<string, UnloadRecord> = new Map();
  // Files not loaded because their skill name is registered from another
  // file, with that name. reconcile() loads them again once it is free.
  private refusedFiles: Map<string, string> = new Map();
  // Files whose path could not be checked when an event for them was
  // handled (an error other than a missing entry). Their skill was unloaded;
  // reconcile() loads them again once the path can be checked.
  private uncertainFiles: Set<string> = new Set();
  private reconcileTimer: NodeJS.Timeout | null = null;
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

    // Before anything is created: chokidar would watch another path.
    if (hasBackslashInName(this.root)) {
      throw new Error(
        `Skills directory ${this.root} has a backslash in its path, which chokidar reads as a separator`
      );
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

    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    // The check alone does not keep the process alive; chokidar does.
    this.reconcileTimer.unref();
    this.generation += 1;
    this.isRunning = true;
  }

  /**
   * Stop watching for file changes. Loads that are still waiting for their
   * debounce are dropped, the check of reconcile() stops, and file events
   * that arrive from now on are ignored.
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
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    // Clear all pending debounce timers
    for (const { timer } of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.refusedFiles.clear();
    this.uncertainFiles.clear();
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
      this.recordUnload(skillFile);
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

    this.refusedFiles.delete(filePath);
    this.uncertainFiles.delete(filePath);
    this.runReportingErrors(filePath, async () => this.unloadFile(filePath));
  }

  /**
   * Runs every RECONCILE_INTERVAL_MS while the watcher runs, for what file
   * events miss. A skill this watcher loaded whose file is no longer a
   * regular file reached without a link (deleted, or replaced by a
   * directory, a FIFO or a link) is unloaded, as loadFile() would on an
   * event. A path that cannot be checked right now is left as it is and
   * checked again on the next pass. A refused file whose skill name is free
   * now, and a file that could not be checked when its event came, are
   * loaded again. A file with a load pending is left to that load.
   */
  private reconcile(): void {
    const generation = this.generation;
    try {
      for (const filePath of [...this.ownedFiles.keys()]) {
        if (generation !== this.generation) return;
        if (this.debounceTimers.has(filePath)) continue;
        const state = inspectPath(this.root, filePath);
        if (state !== 'file' && state !== 'unknown') this.dropUnreachableFile(filePath, state);
      }
      const registry = getSkillRegistry();
      for (const [filePath, name] of [...this.refusedFiles]) {
        if (generation !== this.generation) return;
        if (this.debounceTimers.has(filePath) || registry.has(name)) continue;
        this.refusedFiles.delete(filePath);
        this.runReportingErrors(filePath, () => this.loadFile('add', filePath));
      }
      for (const filePath of [...this.uncertainFiles]) {
        if (generation !== this.generation) return;
        if (this.debounceTimers.has(filePath)) continue;
        this.runReportingErrors(filePath, () => this.loadFile('add', filePath));
      }
    } catch (error) {
      this.emit('error', 'watcher', undefined, error as Error);
    }
  }

  /**
   * Unload the skill of `filePath`, whose path is not a regular file below
   * the skills directory reached without a link: `state` says what it is
   * (see inspectPath). A link, or a path outside the skills directory, that
   * is still there is reported with an 'error' event, after the unload, so
   * nothing a listener does then is undone.
   */
  private dropUnreachableFile(filePath: string, state: PathState): void {
    const isPresentLink = state === 'link' && pathExists(filePath);
    this.unloadFile(filePath);
    if (isPresentLink) {
      const reason = `${filePath} is outside the skills directory or behind a symbolic link`;
      this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
    }
  }

  /** Run a load or unload of `filePath`, and report a failure as an 'error' event. */
  private runReportingErrors(filePath: string, operation: () => Promise<void>): void {
    operation().catch((error: unknown) => {
      this.emit('error', filePath, filePath, error as Error);
    });
  }

  /** Load or reload the skill in `filePath` and report what happened. */
  private async loadFile(eventType: 'add' | 'change', filePath: string): Promise<void> {
    // Refused again below if its name is still taken.
    this.refusedFiles.delete(filePath);
    const wasUncertain = this.uncertainFiles.delete(filePath);
    const state = inspectPath(this.root, filePath);
    if (state === 'unknown') {
      // Not known to be safe to read: unloaded until reconcile() can check it.
      this.unloadFile(filePath);
      this.uncertainFiles.add(filePath);
      if (!wasUncertain) {
        const reason = `${filePath} could not be checked; it is tried again every second`;
        this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
      }
      return;
    }
    if (state === 'link' || state === 'missing') {
      // A link now, or below one, or deleted since the event.
      this.dropUnreachableFile(filePath, state);
      return;
    }

    // A stop() (from a listener, say) while this load waits ends its run.
    const generation = this.generation;
    const skillFile = await loadSkillFromFile(filePath);
    if (generation !== this.generation) {
      return;
    }
    // What this load may replace, taken before any listener runs.
    const replaced = this.findReplaceable(skillFile, filePath);
    // The version this watcher loaded from this file goes when the new one
    // did not load or has another name.
    const owned = this.ownedFiles.get(filePath);
    if (owned && owned.metadata.name !== skillFile?.metadata.name) {
      this.unloadFile(filePath);
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
   * listeners, which can stop the watcher, register the name, from any
   * file, or replace the registry (resetSkillRegistry()). So the run, the
   * registry in use and the name are checked again after each call, and
   * what a listener registered is left alone.
   */
  private registerUnlessTaken(skillFile: SkillFile, load: FileLoad): void {
    const { eventType, filePath, generation } = load;
    const registry = getSkillRegistry();
    const name = skillFile.metadata.name;
    const isCurrent = (): boolean =>
      generation === this.generation && getSkillRegistry() === registry;
    // Only the watcher's own earlier version leaves a record; a skill that
    // something else registered from the file says nothing about the file's
    // disable.
    if (load.replaced && this.ownedFiles.get(filePath) === load.replaced) {
      this.recordUnload(load.replaced);
    }
    const hasDroppedPrevious = this.dropRegistered(load.replaced);
    const owner = registry.getFile(name);
    if (owner || !isCurrent()) {
      if (hasDroppedPrevious) this.emit('unloaded', name, filePath);
      if (owner) {
        // Kept for reconcile() only while this run goes on (stop() clears it).
        if (isCurrent()) this.refusedFiles.set(filePath, name);
        const reason = `the name "${name}" is registered from ${owner.path}`;
        this.emit('error', filePath, filePath, new Error(`Skill not loaded: ${reason}`));
      }
      return;
    }
    const carried = this.carryDisable(skillFile);
    // Defined only when this register made the disable (the carry did, to a
    // name that had none): the one disable undoCarriedDisable() may lift.
    const madeDisable = registry.register(skillFile);
    if (registry.getFile(name) !== skillFile) {
      // A registry listener replaced or removed it during the register.
      if (carried && madeDisable) this.undoCarriedDisable(registry, name, madeDisable);
      return;
    }
    if (!isCurrent()) {
      registry.unregister(name);
      if (carried && madeDisable) this.undoCarriedDisable(registry, name, madeDisable);
      return;
    }
    this.ownedFiles.set(filePath, skillFile);
    // Carried over or not, the record is used up: it never applies to a later load.
    this.lastUnloaded.delete(filePath);
    if (carried) this.releaseOldName(carried, filePath);
    this.emit(eventType === 'add' ? 'loaded' : 'reloaded', name, filePath);
  }

  /**
   * The skill registered under the name `skillFile` has, from the same file:
   * the watcher's own earlier version, or one registered before start(). A
   * load replaces it. One with an onLoad() or onUnload() hook is not
   * replaced, because the watcher runs no hooks; it holds the name.
   */
  private findReplaceable(skillFile: SkillFile | null, filePath: string): SkillFile | undefined {
    if (!skillFile) {
      return undefined;
    }
    const registered = getSkillRegistry().getFile(skillFile.metadata.name);
    const hasHooks = Boolean(registered?.skill.onLoad || registered?.skill.onUnload);
    return registered?.path === filePath && !hasHooks ? registered : undefined;
  }

  /** Unregister `skillFile` if it is still the one registered under its name. True when it was. */
  private dropRegistered(skillFile: SkillFile | undefined): boolean {
    const registry = getSkillRegistry();
    if (!skillFile || registry.getFile(skillFile.metadata.name) !== skillFile) {
      return false;
    }
    if (this.ownedFiles.get(skillFile.path) === skillFile) {
      this.ownedFiles.delete(skillFile.path);
    }
    return registry.unregister(skillFile.metadata.name);
  }

  /**
   * Record the watcher's own skill from a file as the watcher unregisters it:
   * when it is the registered one and disabled, its name and the id of the
   * disable in force (see carryDisable()). Otherwise the file has no record.
   */
  private recordUnload(skillFile: SkillFile): void {
    const registry = getSkillRegistry();
    const name = skillFile.metadata.name;
    const isRegistered = registry.getFile(name) === skillFile;
    const disableId = isRegistered && !skillFile.enabled ? registry.getDisable(name)?.id : undefined;
    if (disableId === undefined) {
      this.lastUnloaded.delete(skillFile.path);
    } else {
      this.lastUnloaded.set(skillFile.path, { name, disableId });
    }
  }

  /**
   * Let a disable follow a file to a new skill name. When the watcher's last
   * skill from this file was disabled under another name, and that disable
   * is still in force (the same disable id: no enable() since), `skillFile`
   * is registered as disabled. Returns the record it carried, if any.
   */
  private carryDisable(skillFile: SkillFile): UnloadRecord | undefined {
    const previous = this.lastUnloaded.get(skillFile.path);
    if (
      !previous ||
      previous.name === skillFile.metadata.name ||
      getSkillRegistry().getDisable(previous.name)?.id !== previous.disableId
    ) {
      return undefined;
    }
    skillFile.enabled = false;
    return previous;
  }

  /**
   * After a disable was carried to a file's new skill name: lift it from the
   * old name, so the disable has moved. Only when that disable was made for
   * this file's skill, is still the one in force, and nothing is registered
   * under the old name. A file that was disabled because it took over a
   * disabled name copies the disable and cannot lift it from that name.
   */
  private releaseOldName(previous: UnloadRecord, filePath: string): void {
    const registry = getSkillRegistry();
    const disable = registry.getDisable(previous.name);
    if (
      !registry.has(previous.name) &&
      disable?.id === previous.disableId &&
      disable.path === filePath
    ) {
      registry.enable(previous.name);
    }
  }

  /**
   * A registration that carried a disable to a name that had none did not
   * stand (the watcher was stopped, the registry replaced, or a listener
   * removed it): lift the disable it made, `made`, from `registry`, the one
   * it was registered in. Only that exact disable, and only while nothing is
   * registered under the name: one a listener made since stays.
   */
  private undoCarriedDisable(registry: SkillRegistry, name: string, made: SkillDisable): void {
    if (!registry.has(name) && registry.getDisable(name)?.id === made.id) {
      registry.enable(name);
    }
  }

  /**
   * Unload the skill this watcher loaded from `filePath`, if it is still the
   * one registered under its name. A skill registered from that file by
   * anything else stays.
   */
  private unloadFile(filePath: string): void {
    const owned = this.ownedFiles.get(filePath);
    this.ownedFiles.delete(filePath);
    if (!owned) return;
    this.recordUnload(owned);
    if (this.dropRegistered(owned)) {
      this.emit('unloaded', owned.metadata.name, filePath);
    }
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
