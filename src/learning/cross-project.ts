/**
 * Cross-Project Learning System
 * Extracts and transfers patterns between projects
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CrossProjectConfig,
  PatternLifecycle,
  TransferablePattern,
  PatternMatchResult,
} from '../types.js';
import { getConfig } from '../utils/config.js';
import { contentSimilarity } from '../utils/similarity.js';

const DEFAULT_CONFIG: Required<CrossProjectConfig> = {
  enabled: true,
  minApplicability: 0.7,
  minRelevance: 0.6,
  maxPatternsPerQuery: 10,
  decayHalfLifeDays: 180,
};

/**
 * Calculate applicability score for a pattern
 * Based on generality, stability, and transfer history
 */
export function assessApplicability(pattern: PatternLifecycle): number {
  let score = 0;

  // Stability contributes to applicability (stable patterns are more reliable)
  score += pattern.stabilityIndex * 0.4;

  // Maturity contributes (mature patterns have proven value)
  score += pattern.maturityScore * 0.3;

  // Has distilled content (core insights extracted)
  if (pattern.distilledContent) {
    score += 0.15;
  }

  // Domain-specific patterns may be less applicable cross-project
  if (pattern.domain === 'general') {
    score += 0.15;
  } else if (pattern.domain) {
    score += 0.05; // Some applicability
  }

  return Math.min(1, score);
}

/**
 * Cross-Project Learning Manager
 * Manages pattern extraction and transfer between projects
 */
export class CrossProjectLearningManager {
  private config: Required<CrossProjectConfig>;
  private patterns: Map<string, TransferablePattern> = new Map();
  private transferLog: Array<{
    patternId: string;
    sourceProject: string;
    targetProject: string;
    timestamp: Date;
  }> = [];
  private dataPath: string;
  private initialized: boolean = false;

  constructor(config?: Partial<CrossProjectConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const titanConfig = getConfig();
    this.dataPath = path.join(titanConfig.dataDir, 'learning', 'cross-project.json');
  }

  /**
   * Initialize the manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.loadFromDisk();
    this.initialized = true;
  }

  private async loadFromDisk(): Promise<void> {
    if (fs.existsSync(this.dataPath)) {
      try {
        const data = JSON.parse(await fs.promises.readFile(this.dataPath, 'utf-8'));

        // Load patterns
        for (const pattern of data.patterns || []) {
          this.patterns.set(pattern.patternId, pattern);
        }

        // Load transfer log
        this.transferLog = (data.transferLog || []).map((t: { timestamp: string }) => ({
          ...t,
          timestamp: new Date(t.timestamp),
        }));
      } catch (error) {
        console.warn('Failed to load cross-project learning state:', error);
      }
    }
  }

  private async saveToDisk(): Promise<void> {
    const dir = path.dirname(this.dataPath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const data = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      patterns: [...this.patterns.values()],
      transferLog: this.transferLog.slice(-1000),
    };

    await fs.promises.writeFile(this.dataPath, JSON.stringify(data, null, 2));
  }

  /**
   * Extract transferable patterns from a project
   */
  async extractPatterns(
    projectId: string,
    patterns: PatternLifecycle[]
  ): Promise<TransferablePattern[]> {
    if (!this.config.enabled) return [];

    const extracted: TransferablePattern[] = [];

    // Filter to stable patterns with high applicability
    const candidates = patterns.filter(p =>
      (p.stage === 'stable' || p.stage === 'mature') &&
      assessApplicability(p) >= this.config.minApplicability
    );

    for (const pattern of candidates) {
      const transferable: TransferablePattern = {
        patternId: pattern.id,
        sourceProject: projectId,
        content: pattern.updateHistory[pattern.updateHistory.length - 1]?.newContent || '',
        distilledContent: pattern.distilledContent,
        applicability: assessApplicability(pattern),
        domain: pattern.domain || 'general',
        stage: pattern.stage,
        transferCount: 0,
      };

      // Check if already exists
      const existingKey = this.findExistingPattern(transferable);
      if (existingKey) {
        // Update existing
        const existing = this.patterns.get(existingKey)!;
        existing.applicability = Math.max(existing.applicability, transferable.applicability);
      } else {
        this.patterns.set(transferable.patternId, transferable);
      }

      extracted.push(transferable);
    }

    await this.saveToDisk();
    return extracted;
  }

  /**
   * Find existing pattern by content similarity
   */
  private findExistingPattern(pattern: TransferablePattern): string | undefined {
    for (const [key, existing] of this.patterns) {
      if (
        existing.domain === pattern.domain &&
        contentSimilarity(pattern.content, existing.content) > 0.9
      ) {
        return key;
      }
    }
    return undefined;
  }

  /**
   * Find relevant patterns for a query/context
   */
  async findRelevantPatterns(
    query: string,
    targetProjectId?: string,
    options?: {
      limit?: number;
      minRelevance?: number;
      domain?: string;
    }
  ): Promise<PatternMatchResult[]> {
    if (!this.config.enabled) return [];

    const limit = options?.limit ?? this.config.maxPatternsPerQuery;
    const minRelevance = options?.minRelevance ?? this.config.minRelevance;

    const results: PatternMatchResult[] = [];

    for (const pattern of this.patterns.values()) {
      // Skip patterns from the same project (unless explicitly requested)
      if (targetProjectId && pattern.sourceProject === targetProjectId) {
        continue;
      }

      // Filter by domain if specified
      if (options?.domain && pattern.domain !== options.domain && pattern.domain !== 'general') {
        continue;
      }

      // Calculate relevance
      const contentToMatch = pattern.distilledContent || pattern.content;
      const relevance = this.calculateRelevance(query, contentToMatch);

      if (relevance >= minRelevance) {
        results.push({
          pattern,
          relevance,
          matchedTerms: this.findMatchedTerms(query, contentToMatch),
        });
      }
    }

    // Sort by relevance and limit
    return results
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  /**
   * Calculate relevance between query and pattern content
   */
  private calculateRelevance(query: string, content: string): number {
    return contentSimilarity(query, content);
  }

  /**
   * Find matching terms between query and content
   */
  private findMatchedTerms(query: string, content: string): string[] {
    const queryTerms = new Set(
      query.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(t => t.length > 2)
    );

    const contentTerms = new Set(
      content.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(t => t.length > 2)
    );

    const matched: string[] = [];
    for (const term of queryTerms) {
      if (contentTerms.has(term)) {
        matched.push(term);
      }
    }

    return matched;
  }

  /**
   * Record a pattern transfer
   */
  async recordTransfer(
    patternId: string,
    targetProject: string
  ): Promise<boolean> {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return false;

    pattern.transferCount++;

    this.transferLog.push({
      patternId,
      sourceProject: pattern.sourceProject,
      targetProject,
      timestamp: new Date(),
    });

    await this.saveToDisk();
    return true;
  }

  /**
   * Apply decay to patterns
   */
  async applyDecay(): Promise<number> {
    const now = Date.now();
    let decayedCount = 0;

    for (const [key, pattern] of this.patterns) {
      // Check if pattern should decay based on transfer history
      const lastTransfer = this.transferLog
        .filter(t => t.patternId === pattern.patternId)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

      const daysSinceTransfer = lastTransfer
        ? (now - lastTransfer.timestamp.getTime()) / (1000 * 60 * 60 * 24)
        : Infinity;

      // Remove patterns that haven't been transferred in a long time
      if (daysSinceTransfer > this.config.decayHalfLifeDays * 2) {
        this.patterns.delete(key);
        decayedCount++;
      } else {
        // Apply applicability decay
        const decayFactor = Math.pow(2, -daysSinceTransfer / this.config.decayHalfLifeDays);
        pattern.applicability *= decayFactor;

        // Remove if applicability drops below threshold
        if (pattern.applicability < 0.1) {
          this.patterns.delete(key);
          decayedCount++;
        }
      }
    }

    if (decayedCount > 0) {
      await this.saveToDisk();
    }

    return decayedCount;
  }

  /**
   * Get all patterns
   */
  getAllPatterns(): TransferablePattern[] {
    return [...this.patterns.values()];
  }

  /**
   * Get patterns by source project
   */
  getPatternsByProject(projectId: string): TransferablePattern[] {
    return [...this.patterns.values()]
      .filter(p => p.sourceProject === projectId);
  }

  /**
   * Get patterns by domain
   */
  getPatternsByDomain(domain: string): TransferablePattern[] {
    return [...this.patterns.values()]
      .filter(p => p.domain === domain || p.domain === 'general');
  }

  /**
   * Get transfer statistics
   */
  getStats(): {
    totalPatterns: number;
    byDomain: Record<string, number>;
    byProject: Record<string, number>;
    totalTransfers: number;
    avgApplicability: number;
  } {
    const byDomain: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let totalApplicability = 0;

    for (const pattern of this.patterns.values()) {
      byDomain[pattern.domain] = (byDomain[pattern.domain] || 0) + 1;
      byProject[pattern.sourceProject] = (byProject[pattern.sourceProject] || 0) + 1;
      totalApplicability += pattern.applicability;
    }

    return {
      totalPatterns: this.patterns.size,
      byDomain,
      byProject,
      totalTransfers: this.transferLog.length,
      avgApplicability: this.patterns.size > 0
        ? totalApplicability / this.patterns.size
        : 0,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CrossProjectConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Close and save
   */
  async close(): Promise<void> {
    await this.saveToDisk();
    this.patterns.clear();
    this.transferLog = [];
    this.initialized = false;
  }
}

/**
 * Create a cross-project learning manager
 */
export function createCrossProjectLearningManager(
  config?: Partial<CrossProjectConfig>
): CrossProjectLearningManager {
  return new CrossProjectLearningManager(config);
}
