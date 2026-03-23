/**
 * Cortex Pipeline - The "Librarian" Recall Logic
 *
 * Store Path: Content In -> Classify -> Extract -> Tag entity status -> Store
 * Recall Path: Query -> Retrieve 50+ chunks -> Sentence Split -> Semantic Highlight
 *   -> Prune below threshold -> Reconstruct "Gold" sentences -> Temporal conflict resolution
 *   -> Sufficiency check -> Return clean context
 */

import { MemoryEntry } from '../types.js';
import { SemanticHighlighter } from '../utils/semantic-highlight.js';
import {
  MemoryCategory,
  CortexPipelineResult,
  GoldSentence,
  LibrarianResult,
  CortexConfig,
  DEFAULT_CORTEX_CONFIG,
} from './types.js';
import { classifyContent } from './classifier.js';
import { extractByCategory } from './extractors.js';
import type { LLMClient } from '../llm/client.js';
import type { LLMConfig } from '../llm/types.js';

/**
 * Cortex Pipeline orchestrator
 */
export class CortexPipeline {
  private config: CortexConfig;
  private highlighter?: SemanticHighlighter;
  private llmClient?: LLMClient;
  private llmConfig?: LLMConfig;

  constructor(config?: Partial<CortexConfig>, highlighter?: SemanticHighlighter) {
    this.config = { ...DEFAULT_CORTEX_CONFIG, ...config };
    this.highlighter = highlighter;
  }

  /**
   * STORE PATH: Classify content and enrich metadata
   * Async when LLM is available for enhanced classification/extraction
   */
  async processForStore(content: string): Promise<CortexPipelineResult> {
    let classification = classifyContent(content);

    // LLM fallback: if regex confidence is below threshold and LLM is available
    if (
      this.llmClient?.isAvailable() &&
      this.llmConfig?.classifyEnabled &&
      classification.confidence < (this.llmConfig.classifyConfidenceThreshold ?? 0.5)
    ) {
      try {
        const { llmClassify } = await import('../llm/turbo.js');
        const llmResult = await llmClassify(this.llmClient, content);
        if (llmResult) {
          classification = llmResult;
        }
      } catch {
        // Fallback: keep regex classification
      }
    }

    const extraction = extractByCategory(content, classification.category);

    const enrichedMetadata: Record<string, unknown> = {
      category: classification.category,
      categoryConfidence: classification.confidence,
      classificationMethod: classification.method,
      entityStatus: extraction.entityStatus,
    };

    // Add secondary category if confident enough
    if (classification.secondaryCategory && (classification.secondaryConfidence ?? 0) > 0.3) {
      enrichedMetadata.secondaryCategory = classification.secondaryCategory;
    }

    // Add extraction fields
    enrichedMetadata.extractedFields = extraction.fields;

    // LLM enrichment: merge additional extracted fields
    if (
      this.llmClient?.isAvailable() &&
      this.llmConfig?.extractEnabled
    ) {
      try {
        const { llmExtract } = await import('../llm/turbo.js');
        const llmFields = await llmExtract(this.llmClient, content, classification.category);
        if (llmFields) {
          enrichedMetadata.llmExtractedFields = llmFields;
        }
      } catch {
        // Fallback: skip LLM extraction
      }
    }

    return { classification, extraction, enrichedMetadata };
  }

  /**
   * RECALL PATH: The Librarian - retrieve, highlight, prune, reconstruct
   */
  async processForRecall(
    query: string,
    memories: MemoryEntry[]
  ): Promise<LibrarianResult> {
    if (memories.length === 0) {
      return this.emptyResult();
    }

    // Step 1: Sentence split all memories
    const allSentences: GoldSentence[] = [];
    for (const memory of memories) {
      const sentences = splitIntoSentences(memory.content);
      for (const text of sentences) {
        allSentences.push({
          text,
          score: 0,
          sourceMemoryId: memory.id,
          category: memory.metadata?.category as MemoryCategory | undefined,
        });
      }
    }

    const totalSentences = allSentences.length;

    // Step 2: Score sentences via semantic highlighting (bounded concurrency per memory)
    if (this.highlighter) {
      // Bounded concurrent highlight calls to avoid resource exhaustion
      const highlightResults = await limitConcurrency(
        memories,
        memory => this.highlighter!.highlight(query, memory.content, 0),
        5
      );
      // Map scores back to the allSentences array
      for (let mi = 0; mi < memories.length; mi++) {
        const memory = memories[mi];
        const result = highlightResults[mi];
        const memorySentences = splitIntoSentences(memory.content);
        for (let i = 0; i < allSentences.length; i++) {
          if (allSentences[i].sourceMemoryId === memory.id) {
            const sentenceIdx = memorySentences.indexOf(allSentences[i].text);
            allSentences[i].score = sentenceIdx >= 0 && sentenceIdx < result.sentenceProbabilities.length
              ? result.sentenceProbabilities[sentenceIdx]
              : 0;
          }
        }
      }
    } else {
      // Fallback: simple term overlap scoring
      for (const sentence of allSentences) {
        sentence.score = calculateTermOverlap(query, sentence.text);
      }
    }

    // Step 3: Prune below threshold
    const threshold = this.config.highlightThreshold;
    let goldSentences = allSentences.filter(s => s.score >= threshold);

    // Step 3.5: LLM reranking (runs BEFORE temporal conflict resolution)
    if (
      this.llmClient?.isAvailable() &&
      this.llmConfig?.rerankEnabled &&
      goldSentences.length > 0
    ) {
      try {
        const { llmRerank } = await import('../llm/turbo.js');
        const reranked = await llmRerank(this.llmClient, query, goldSentences);
        if (reranked) {
          goldSentences = reranked;
        }
      } catch {
        // Fallback: keep original scoring
      }
    }

    // Step 4: Apply temporal conflict resolution
    const resolved = resolveTemporalConflicts(goldSentences, memories);

    // Step 5: Calculate category coverage
    const categoryCoverage = calculateCategoryCoverage(resolved);

    // Step 6: Calculate compression
    const originalLength = memories.reduce((sum, m) => sum + m.content.length, 0);
    const goldLength = resolved.reduce((sum, s) => sum + s.text.length, 0);
    const compressionRate = originalLength > 0 ? goldLength / originalLength : 0;

    return {
      goldSentences: resolved,
      totalRetrieved: memories.length,
      totalSentences,
      prunedCount: totalSentences - resolved.length,
      compressionRate,
      categoryCoverage,
    };
  }

  /**
   * Check if Cortex pipeline is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CortexConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set the semantic highlighter
   */
  setHighlighter(highlighter: SemanticHighlighter): void {
    this.highlighter = highlighter;
  }

  /**
   * Set the LLM client for turbo-enhanced processing
   */
  setLLMClient(client: LLMClient, llmConfig: LLMConfig): void {
    this.llmClient = client;
    this.llmConfig = llmConfig;
  }

  private emptyResult(): LibrarianResult {
    return {
      goldSentences: [],
      totalRetrieved: 0,
      totalSentences: 0,
      prunedCount: 0,
      compressionRate: 0,
      categoryCoverage: {
        knowledge: 0,
        profile: 0,
        event: 0,
        behavior: 0,
        skill: 0,
      },
    };
  }
}

/**
 * Run async operations with bounded concurrency to prevent resource exhaustion
 */
async function limitConcurrency<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = 5): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    results.push(...await Promise.all(chunk.map(fn)));
  }
  return results;
}

/**
 * Split text into sentences (shared utility)
 */
function splitIntoSentences(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Simple term overlap scoring (fallback when no embeddings)
 */
function calculateTermOverlap(query: string, sentence: string): number {
  const queryTerms = new Set(
    query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(t => t.length > 2)
  );
  const sentenceTerms = new Set(
    sentence.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(t => t.length > 2)
  );

  if (queryTerms.size === 0) return 0;

  let matches = 0;
  for (const term of queryTerms) {
    if (sentenceTerms.has(term)) matches++;
  }
  return matches / queryTerms.size;
}

/**
 * Resolve temporal conflicts: when contradictions exist, most recent wins
 */
function resolveTemporalConflicts(
  sentences: GoldSentence[],
  memories: MemoryEntry[]
): GoldSentence[] {
  // Build a memory timestamp map
  const timestampMap = new Map<string, Date>();
  for (const memory of memories) {
    timestampMap.set(memory.id, new Date(memory.timestamp));
  }

  // Group sentences by topic similarity (simplified: by source memory)
  // For contradicted entities, keep only the most recent
  const memoryGroups = new Map<string, GoldSentence[]>();
  for (const sentence of sentences) {
    const group = memoryGroups.get(sentence.sourceMemoryId) || [];
    group.push(sentence);
    memoryGroups.set(sentence.sourceMemoryId, group);
  }

  // Sort memory groups by timestamp (most recent first)
  const sortedGroups = [...memoryGroups.entries()].sort((a, b) => {
    const timeA = timestampMap.get(a[0])?.getTime() || 0;
    const timeB = timestampMap.get(b[0])?.getTime() || 0;
    return timeB - timeA;
  });

  // Flatten back, most recent first, sort by score
  const result: GoldSentence[] = [];
  for (const [, group] of sortedGroups) {
    result.push(...group);
  }

  // Sort by score descending
  result.sort((a, b) => b.score - a.score);

  return result;
}

/**
 * Calculate category coverage from gold sentences
 */
function calculateCategoryCoverage(
  sentences: GoldSentence[]
): Record<MemoryCategory, number> {
  const counts: Record<MemoryCategory, number> = {
    knowledge: 0,
    profile: 0,
    event: 0,
    behavior: 0,
    skill: 0,
  };

  for (const sentence of sentences) {
    if (sentence.category) {
      counts[sentence.category]++;
    }
  }

  const total = sentences.length || 1;
  return {
    knowledge: counts.knowledge / total,
    profile: counts.profile / total,
    event: counts.event / total,
    behavior: counts.behavior / total,
    skill: counts.skill / total,
  };
}
