/**
 * Cortex Type Definitions
 * 5-type memory categorization system (memU-inspired)
 */

import { MemoryLayer } from '../types.js';

/**
 * Memory categories (memU's 5-type system)
 */
export type MemoryCategory = 'knowledge' | 'profile' | 'event' | 'behavior' | 'skill';

/**
 * Entity status for re-ranking metadata
 */
export type EntityStatus = 'active' | 'historical' | 'contradicted' | 'verified';

/**
 * Classification result from the hybrid classifier
 */
export interface CategoryClassification {
  category: MemoryCategory;
  confidence: number;
  method: 'regex' | 'semantic' | 'fallback' | 'llm';
  secondaryCategory?: MemoryCategory;
  secondaryConfidence?: number;
}

/**
 * Sufficiency check result for recall pipeline
 */
export interface SufficiencyResult {
  sufficient: boolean;
  coverageRatio: number;
  missingCategories: MemoryCategory[];
  categoryBreakdown: Record<MemoryCategory, number>;
}

/**
 * Category-specific extraction result
 */
export interface CategoryExtraction {
  category: MemoryCategory;
  fields: Record<string, unknown>;
  entityStatus: EntityStatus;
}

/**
 * Knowledge extraction fields
 */
export interface KnowledgeExtraction {
  definitions: string[];
  apiEndpoints: string[];
  versions: string[];
  specs: string[];
}

/**
 * Profile extraction fields
 */
export interface ProfileExtraction {
  preferences: Array<{ key: string; value: string }>;
  settings: Array<{ key: string; value: string }>;
}

/**
 * Event extraction fields
 */
export interface EventExtraction {
  timestamps: string[];
  actors: string[];
  outcomes: string[];
  errors: string[];
}

/**
 * Behavior extraction fields
 */
export interface BehaviorExtraction {
  patterns: string[];
  rationale: string[];
  alternatives: string[];
  decisions: string[];
}

/**
 * Skill extraction fields
 */
export interface SkillExtraction {
  steps: string[];
  prerequisites: string[];
  codeSnippets: string[];
  tools: string[];
}

/**
 * Full Cortex pipeline result
 */
export interface CortexPipelineResult {
  classification: CategoryClassification;
  extraction: CategoryExtraction;
  enrichedMetadata: Record<string, unknown>;
}

/**
 * Gold sentence from the Librarian recall pipeline
 */
export interface GoldSentence {
  text: string;
  score: number;
  sourceMemoryId: string;
  category?: MemoryCategory;
}

/**
 * Librarian recall pipeline result
 */
export interface LibrarianResult {
  goldSentences: GoldSentence[];
  totalRetrieved: number;
  totalSentences: number;
  prunedCount: number;
  compressionRate: number;
  categoryCoverage: Record<MemoryCategory, number>;
}

/**
 * Category summary (add-only, versioned)
 */
export interface CategorySummary {
  category: MemoryCategory;
  version: number;
  summary: string;
  entryCount: number;
  lastUpdated: Date;
  keyTerms: string[];
}

/**
 * Merge result
 */
export interface MergeResult {
  action: 'merged' | 'replaced' | 'kept' | 'skipped';
  reason: string;
  resultContent?: string;
}

/**
 * Cortex configuration
 */
export interface CortexConfig {
  enabled: boolean;
  retrieveCount: number;
  highlightThreshold: number;
  classifierConfidenceThreshold: number;
  enableGuardrails: boolean;
  enableDriftMonitor: boolean;
  enableProjectHooks: boolean;
  bedrockRulesPath: string;
}

/**
 * Default Cortex configuration
 */
export const DEFAULT_CORTEX_CONFIG: CortexConfig = {
  enabled: false,
  retrieveCount: 50,
  highlightThreshold: 0.8,
  classifierConfidenceThreshold: 0.6,
  enableGuardrails: false,
  enableDriftMonitor: false,
  enableProjectHooks: false,
  bedrockRulesPath: '',
};

/**
 * Category-to-Layer mapping (memU -> Titan)
 */
export const CATEGORY_LAYER_MAP: Record<MemoryCategory, MemoryLayer[]> = {
  knowledge: [MemoryLayer.FACTUAL, MemoryLayer.LONG_TERM],
  profile: [MemoryLayer.SEMANTIC],
  event: [MemoryLayer.EPISODIC],
  behavior: [MemoryLayer.SEMANTIC],
  skill: [MemoryLayer.SEMANTIC],
};

/**
 * Intent guardrail action
 */
export type GuardrailAction = 'allow' | 'deny' | 'warn';

/**
 * Intent guardrail result
 */
export interface GuardrailResult {
  action: GuardrailAction;
  reason: string;
  rule?: string;
}

/**
 * Bedrock rule definition
 */
export interface BedrockRule {
  id: string;
  description: string;
  condition: string;
  action: GuardrailAction;
  category?: MemoryCategory;
  toolName?: string;
  intentPatterns: string[];
}

/**
 * Drift monitoring entry
 */
export interface DriftEntry {
  timestamp: Date;
  memoryId: string;
  originalCategory: MemoryCategory;
  feedbackSignal: 'helpful' | 'harmful';
  isCorrect: boolean;
  embedding?: number[];
}

/**
 * Embedding drift metrics
 */
export interface EmbeddingDriftMetrics {
  centroidDistance: number;
  recentCentroid: number[] | null;
  historicalCentroid: number[] | null;
  sampleCount: number;
  driftDetected: boolean;
}

/**
 * Drift statistics
 */
export interface DriftStats {
  totalClassifications: number;
  correctClassifications: number;
  accuracy: number;
  byCategoryAccuracy: Record<MemoryCategory, { correct: number; total: number; accuracy: number }>;
  recentTrend: 'improving' | 'stable' | 'degrading';
  alertThreshold: number;
  belowThreshold: boolean;
  embeddingDrift?: EmbeddingDriftMetrics;
}
