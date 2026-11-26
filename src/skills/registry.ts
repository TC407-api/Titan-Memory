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

export class SkillRegistry {
  private skills: Map<string, SkillRegistryEntry> = new Map();
  private triggerIndex: Map<string, string[]> = new Map(); // trigger -> skill names
  private listeners: SkillEventListener[] = [];
  private executionStats: Map<string, { count: number; totalTimeMs: number }> = new Map();
  private lastReloadAt?: Date;
  // What disable() was called for: the skill's name and the file it was
  // loaded from at that time. Kept when the skill is unregistered, so that
  // loading its file again does not make it runnable again.
  private disabledSkills: Array<{ name: string; path: string }> = [];

  /**
   * Register a skill.
   *
   * A skill is registered as disabled, whatever `file.enabled` says, when
   * its name or its file was disabled and not enabled since: only enable()
   * makes it runnable again. The loader builds a new SkillFile with
   * `enabled: true` each time a file is loaded, so without this an edited or
   * re-added file would undo a disable(). The file counts as well as the
   * name because an edit can give the skill in a file another name. The
   * disable then belongs to the new name, and the old name is free again.
   */
  register(file: SkillFile): void {
    const { metadata } = file;
    const name = metadata.name;

    if (!file.enabled || this.isDisabledSkill(name, file.path)) {
      file.enabled = false;
      this.rememberDisabledSkill(name, file.path);
    }

    // Unregister existing skill with same name
    if (this.skills.has(name)) {
      this.unregister(name);
    }

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
   * Either way the name, and the file it was disabled with, are no longer
   * remembered as disabled, so a skill that is not registered right now is
   * enabled when it is registered again.
   */
  enable(name: string): boolean {
    const entry = this.skills.get(name);
    this.forgetDisabledSkill(name, entry?.file.path);
    if (!entry) return false;
    entry.file.enabled = true;
    return true;
  }

  /**
   * Disable a skill. Returns false when no skill of that name is registered.
   * The name and its file stay disabled until enable() is called, also when
   * the skill is unregistered and registered again in between.
   */
  disable(name: string): boolean {
    const entry = this.skills.get(name);
    if (!entry) return false;
    entry.file.enabled = false;
    this.rememberDisabledSkill(name, entry.file.path);
    return true;
  }

  private isDisabledSkill(name: string, filePath: string): boolean {
    return this.disabledSkills.some((skill) => skill.name === name || skill.path === filePath);
  }

  /** Drop what is remembered for this name and, when given, for this file. */
  private forgetDisabledSkill(name: string, filePath?: string): void {
    this.disabledSkills = this.disabledSkills.filter(
      (skill) => skill.name !== name && skill.path !== filePath
    );
  }

  /** Remember one entry for this name and file, in place of older ones for either. */
  private rememberDisabledSkill(name: string, filePath: string): void {
    this.forgetDisabledSkill(name, filePath);
    this.disabledSkills.push({ name, path: filePath });
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
   * Clear all skills. What was disabled stays remembered, as the execution
   * statistics do; resetSkillRegistry() starts without it.
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
