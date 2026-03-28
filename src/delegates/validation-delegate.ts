/**
 * ValidationDelegate - Extracted from TitanMemory
 * Handles behavioral validation and quality scoring
 */

import { BehavioralValidator, QualityScore } from '../validation/behavioral-validator.js';
import type { MemoryEntry } from '../types.js';
import type { SufficiencyResult } from '../cortex/types.js';
import { checkSufficiency, getRelevantCategories } from '../cortex/retrieval.js';

export class ValidationDelegate {
  constructor(
    private validator: BehavioralValidator,
  ) {}

  /**
   * Get quality score for a memory
   */
  getQualityScore(memory: MemoryEntry): QualityScore {
    return this.validator.calculateQualityScore(memory);
  }

  /**
   * Check sufficiency of recall results across categories
   */
  checkCategorySufficiency(memories: MemoryEntry[], query: string): SufficiencyResult {
    const targetCategories = getRelevantCategories(query);
    return checkSufficiency(memories, targetCategories);
  }
}
