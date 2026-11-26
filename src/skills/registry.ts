/**
 * Titan Memory Skill Registry
 * Manages skill registration, discovery, and lookup
 */

import {
  TitanSkill,
  SkillFile,
  SkillRegistryEntry,
  SkillMetadata,
  SkillEvent,
  SkillEventListener,
  SkillSystemStats,
} from './types.js';

/** A disable in force for a skill name (see SkillRegistry.getDisable()). */
export interface SkillDisable {
  /** Unique in the process, also across registries (resetSkillRegistry()). */
  readonly id: number;
  /** The file of the skill the disable was made for. */
  readonly path: string;
}

// Module-wide, so a disable id never repeats in a new registry.
let nextDisableId = 1;

export class SkillRegistry {
  private skills: Map<string, SkillRegistryEntry> = new Map();
  private triggerIndex: Map<string, string[]> = new Map(); // trigger -> skill names
  private listeners: SkillEventListener[] = [];
  private executionStats: Map<string, { count: number; totalTimeMs: number }> = new Map();
  private lastReloadAt?: Date;
  // The names that are disabled: by disable(), or by registering a SkillFile
  // with `enabled: false`. A name stays here, also while nothing is
  // registered under it, until enable() is called for it. Only names are
  // kept, never files: enable() and disable() take a name, and each changes
  // the state of that one name only. Each name maps to the disable in force
  // (see getDisable()).
  private disabledNames: Map<string, SkillDisable> = new Map();

  /**
   * Register a skill.
   *
   * The skill is registered as disabled, whatever `file.enabled` says, when
   * its name is disabled (see isNameDisabled()). The loader builds a new
   * SkillFile with `enabled: true` each time a file is loaded, so without
   * this an edited or re-added file would undo a disable(). Any file
   * registered under a disabled name is disabled, and a SkillFile that is
   * registered with `enabled: false` disables its name.
   *
   * The state belongs to the name, not to the file: a file whose skill now
   * has another name registers a skill under that name, in that name's state.
   * (The skill watcher carries a disable over to the new name of a file it
   * loaded; see SkillWatcher.)
   */
  register(file: SkillFile): void {
    const { metadata } = file;
    const name = metadata.name;

    // Unregister existing skill with same name
    if (this.skills.has(name)) {
      this.unregister(name);
    }

    // Decided after that unregister, whose listeners can call enable().
    if (!file.enabled) {
      this.markDisabled(name, file.path);
    }
    file.enabled = !this.disabledNames.has(name);

    // Create registry entry
    const entry: SkillRegistryEntry = {
      name,
      file,
      triggers: new Map(metadata.triggers.map(t => [t.toLowerCase(), true])),
    };

    // Register skill
    this.skills.set(name, entry);

    // Index triggers for fast lookup
    for (const trigger of metadata.triggers) {
      const normalizedTrigger = trigger.toLowerCase();
      const skillNames = this.triggerIndex.get(normalizedTrigger) || [];
      if (!skillNames.includes(name)) {
        skillNames.push(name);
        this.triggerIndex.set(normalizedTrigger, skillNames);
      }
    }

    // Initialize execution stats
    if (!this.executionStats.has(name)) {
      this.executionStats.set(name, { count: 0, totalTimeMs: 0 });
    }

    this.emit({ type: 'skill:loaded', name, path: file.path });
  }

  /**
   * Unregister a skill
   */
  unregister(name: string): boolean {
    const entry = this.skills.get(name);
    if (!entry) return false;

    // Remove from trigger index
    for (const [trigger, skillNames] of this.triggerIndex) {
      const index = skillNames.indexOf(name);
      if (index >= 0) {
        skillNames.splice(index, 1);
        if (skillNames.length === 0) {
          this.triggerIndex.delete(trigger);
        }
      }
    }

    // Remove from registry
    this.skills.delete(name);

    this.emit({ type: 'skill:unloaded', name });
    return true;
  }

  /**
   * Get a skill by name
   */
  get(name: string): TitanSkill | undefined {
    return this.skills.get(name)?.file.skill;
  }

  /**
   * Get skill file info by name
   */
  getFile(name: string): SkillFile | undefined {
    return this.skills.get(name)?.file;
  }

  /**
   * Find skills by trigger word
   */
  findByTrigger(trigger: string): TitanSkill[] {
    const normalizedTrigger = trigger.toLowerCase();
    const skillNames = this.triggerIndex.get(normalizedTrigger) || [];
    return skillNames
      .map(name => this.skills.get(name)?.file.skill)
      .filter((s): s is TitanSkill => s !== undefined && this.isEnabled(s.metadata.name));
  }

  /**
   * Find first skill matching any trigger in text
   */
  findByText(text: string): TitanSkill | undefined {
    const lowerText = text.toLowerCase();

    for (const [trigger, skillNames] of this.triggerIndex) {
      if (lowerText.includes(trigger)) {
        for (const name of skillNames) {
          const entry = this.skills.get(name);
          if (entry?.file.enabled) {
            return entry.file.skill;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Check if a skill is enabled
   */
  isEnabled(name: string): boolean {
    return this.skills.get(name)?.file.enabled ?? false;
  }

  /**
   * Enable a skill. Returns false when no skill of that name is registered.
   *
   * The name is no longer disabled, whether or not a skill is registered
   * under it: a skill registered under it later is enabled. No other name
   * changes, also not another name registered from the same file.
   */
  enable(name: string): boolean {
    this.disabledNames.delete(name);
    const entry = this.skills.get(name);
    if (!entry) return false;
    entry.file.enabled = true;
    return true;
  }

  /**
   * Disable a skill. Returns false, and changes nothing, when no skill of
   * that name is registered. The name stays disabled until enable() is
   * called for it, also when the skill is unregistered and registered again
   * in between. No other name changes.
   */
  disable(name: string): boolean {
    const entry = this.skills.get(name);
    if (!entry) return false;
    entry.file.enabled = false;
    this.markDisabled(name, entry.file.path);
    return true;
  }

  /**
   * Disable a name that is not disabled yet, under a new disable id, for
   * the skill from `filePath`. A name that is disabled already keeps its
   * disable, and the file that disable was made for.
   */
  private markDisabled(name: string, filePath: string): void {
    if (!this.disabledNames.has(name)) {
      this.disabledNames.set(name, { id: nextDisableId++, path: filePath });
    }
  }

  /**
   * The disable in force for the name, or undefined when the name is not
   * disabled: its id, and the file of the skill it was made for (the skill
   * registered under the name when disable() was called, or the SkillFile
   * registered with `enabled: false`). A skill from another file registered
   * under the name later is disabled by it, but the disable stays made for
   * the first file.
   *
   * A name gets a new id each time it goes from enabled to disabled;
   * disabling it again while it is disabled keeps the id. Ids are unique in
   * the process, also across registries. So when an id read earlier is
   * still the one in force, enable() has not been called for the name
   * since, and a later disable cannot be taken for the earlier one.
   */
  getDisable(name: string): SkillDisable | undefined {
    return this.disabledNames.get(name);
  }

  /**
   * True when the name is disabled: disable() was called for it, or a
   * SkillFile was registered under it with `enabled: false`, and enable()
   * has not been called for it since. Also true while no skill is
   * registered under the name; isEnabled() answers for a registered skill.
   */
  isNameDisabled(name: string): boolean {
    return this.disabledNames.has(name);
  }

  /**
   * List all registered skills
   */
  list(): SkillMetadata[] {
    return Array.from(this.skills.values())
      .map(entry => entry.file.metadata);
  }

  /**
   * List enabled skills
   */
  listEnabled(): SkillMetadata[] {
    return Array.from(this.skills.values())
      .filter(entry => entry.file.enabled)
      .map(entry => entry.file.metadata);
  }

  /**
   * List disabled skills
   */
  listDisabled(): SkillMetadata[] {
    return Array.from(this.skills.values())
      .filter(entry => !entry.file.enabled)
      .map(entry => entry.file.metadata);
  }

  /**
   * Check if a skill exists
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * Get total skill count
   */
  count(): number {
    return this.skills.size;
  }

  /**
   * Record skill execution
   */
  recordExecution(name: string, durationMs: number, success: boolean): void {
    const stats = this.executionStats.get(name);
    if (stats) {
      stats.count++;
      stats.totalTimeMs += durationMs;
    }
    this.emit({ type: 'skill:executed', name, success, durationMs });
  }

  /**
   * Mark reload timestamp
   */
  markReload(): void {
    this.lastReloadAt = new Date();
  }

  /**
   * Get system statistics
   */
  getStats(): SkillSystemStats {
    const entries = Array.from(this.skills.values());
    const enabledCount = entries.filter(e => e.file.enabled).length;

    let totalExecutions = 0;
    let totalTimeMs = 0;

    for (const stats of this.executionStats.values()) {
      totalExecutions += stats.count;
      totalTimeMs += stats.totalTimeMs;
    }

    // Count built-in vs custom
    const builtInSkills = entries.filter(e =>
      e.file.path.includes('built-in') || e.file.path.includes('builtin')
    ).length;

    return {
      totalSkills: this.skills.size,
      enabledSkills: enabledCount,
      disabledSkills: this.skills.size - enabledCount,
      builtInSkills,
      customSkills: this.skills.size - builtInSkills,
      totalExecutions,
      averageExecutionTimeMs: totalExecutions > 0 ? totalTimeMs / totalExecutions : 0,
      lastReloadAt: this.lastReloadAt,
    };
  }

  /**
   * Get execution stats for a specific skill
   */
  getSkillStats(name: string): { count: number; avgTimeMs: number } | undefined {
    const stats = this.executionStats.get(name);
    if (!stats) return undefined;
    return {
      count: stats.count,
      avgTimeMs: stats.count > 0 ? stats.totalTimeMs / stats.count : 0,
    };
  }

  /**
   * Add event listener
   */
  addEventListener(listener: SkillEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: SkillEventListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: SkillEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('Skill event listener error:', error);
      }
    }
  }

  /**
   * Clear all skills. The disabled names stay disabled, as the execution
   * statistics stay; resetSkillRegistry() starts without them.
   */
  clear(): void {
    for (const name of this.skills.keys()) {
      this.unregister(name);
    }
  }
}

// Singleton instance
let registryInstance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!registryInstance) {
    registryInstance = new SkillRegistry();
  }
  return registryInstance;
}

export function resetSkillRegistry(): void {
  if (registryInstance) {
    registryInstance.clear();
  }
  registryInstance = null;
}
