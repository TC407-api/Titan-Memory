/**
 * LearningDelegate - Extracted from TitanMemory
 * Handles cross-project learning, pattern matching, and continual learning
 */

import { ContinualLearner } from '../learning/continual-learner.js';
import { CrossProjectLearningManager } from '../learning/cross-project.js';
import { PatternMatcher } from '../learning/pattern-matcher.js';
import { PatternMatchResult, TransferablePattern } from '../types.js';

export class LearningDelegate {
  constructor(
    private continualLearner: ContinualLearner,
    private getCrossProjectLearner: () => CrossProjectLearningManager | undefined,
    private getPatternMatcher: () => PatternMatcher | undefined,
    private getActiveProjectId: () => string | undefined,
    private ensureInitialized: () => Promise<void>,
  ) {}

  /**
   * Get plasticity index for a pattern
   */
  getPlasticityIndex(patternId: string): number {
    return this.continualLearner.getPlasticityIndex(patternId);
  }

  /**
   * Get stability index for a pattern
   */
  getStabilityIndex(patternId: string): number {
    return this.continualLearner.getStabilityIndex(patternId);
  }

  /**
   * Update domain learning rate based on success/failure feedback
   */
  updateDomainLearningRate(domain: string, success: boolean): void {
    this.continualLearner.updateDomainLearningRate(domain, success);
  }

  /**
   * Find relevant patterns across projects
   * Feature 7: Cross-Project Learning
   */
  async findRelevantPatterns(
    query: string,
    options?: {
      limit?: number;
      minRelevance?: number;
      domain?: string;
    }
  ): Promise<PatternMatchResult[]> {
    await this.ensureInitialized();

    const crossProjectLearner = this.getCrossProjectLearner();
    const patternMatcher = this.getPatternMatcher();

    if (!crossProjectLearner || !patternMatcher) {
      return [];
    }

    const patterns = crossProjectLearner.getAllPatterns();
    return patternMatcher.match(query, patterns, {
      maxResults: options?.limit || 10,
      minRelevance: options?.minRelevance || 0.6,
      domains: options?.domain ? [options.domain] : undefined,
    });
  }

  /**
   * Extract transferable patterns from current project
   * Feature 7: Cross-Project Learning
   */
  async extractTransferablePatterns(): Promise<TransferablePattern[]> {
    await this.ensureInitialized();

    const crossProjectLearner = this.getCrossProjectLearner();
    if (!crossProjectLearner) {
      return [];
    }

    const projectId = this.getActiveProjectId() || 'default';
    const stablePatterns = await this.continualLearner.getPatternsByStage('stable');
    const maturePatterns = await this.continualLearner.getPatternsByStage('mature');

    return crossProjectLearner.extractPatterns(
      projectId,
      [...stablePatterns, ...maturePatterns]
    );
  }

  /**
   * Record a pattern transfer for analytics
   * Feature 7: Cross-Project Learning
   */
  async recordPatternTransfer(patternId: string): Promise<boolean> {
    const crossProjectLearner = this.getCrossProjectLearner();
    if (!crossProjectLearner) {
      return false;
    }

    const projectId = this.getActiveProjectId() || 'default';
    return crossProjectLearner.recordTransfer(patternId, projectId);
  }
}
