/**
 * Semantic Highlighting Utility
 * Highlights relevant sentences in retrieved memories based on query
 *
 * Scoring priority chain:
 *   1. Zilliz semantic-highlight-bilingual-v1 (0.6B local model via sidecar HTTP service)
 *   2. Voyage AI embeddings (cosine similarity)
 *   3. Term overlap (keyword fallback)
 */

import { HighlightResult, SemanticHighlightConfig } from '../types.js';
import { IEmbeddingGenerator } from '../storage/vector-storage.js';
import { cosineSimilarity } from '../storage/embeddings/index.js';

const DEFAULT_CONFIG: Required<SemanticHighlightConfig> = {
  enabled: true,
  // 0.2, not 0.5. Measured 2026-08-14 against the live sidecar on three
  // realistic query/document pairs. The model discriminates extremely well —
  // 544x separation between the correct sentence and the next best — but its
  // absolute probabilities are LOW: correct answers scored 0.4517, 0.5655 and
  // 0.2719. At 0.5 two of those three queries returned NOTHING AT ALL, which is
  // the worst possible failure here: the caller gets an empty highlight and
  // reads it as "no relevant content" rather than "threshold ate the answer".
  // 0.2 is the highest value that kept the correct sentence, and only the
  // correct sentence, on all three. Re-measure before raising it.
  threshold: 0.2,
  model: 'zilliz',  // Prefer Zilliz model via sidecar
  highlightOnRecall: true,
  maxSentences: 100,
};

/** Default URL for the Zilliz highlight sidecar service */
const ZILLIZ_SERVICE_URL = process.env.TITAN_HIGHLIGHT_URL || 'http://127.0.0.1:8079';

/** Cache the sidecar availability check so we don't spam failed requests */
let _sidecarAvailable: boolean | null = null;
let _sidecarCheckTime = 0;
const SIDECAR_CHECK_INTERVAL_MS = 30_000; // Re-check every 30s

/**
 * Split text into sentences
 */
function splitIntoSentences(text: string): string[] {
  const sentences = text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  return sentences;
}

/**
 * Calculate term overlap between query and sentence (fallback method)
 */
function calculateTermOverlap(query: string, sentence: string): number {
  const queryTerms = new Set(
    query.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 2)
  );

  const sentenceTerms = new Set(
    sentence.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 2)
  );

  if (queryTerms.size === 0) return 0;

  let matches = 0;
  for (const term of queryTerms) {
    if (sentenceTerms.has(term)) {
      matches++;
    }
  }

  return matches / queryTerms.size;
}

/**
 * Check if the Zilliz highlight sidecar service is running
 */
async function checkSidecarAvailable(): Promise<boolean> {
  const now = Date.now();
  if (_sidecarAvailable !== null && (now - _sidecarCheckTime) < SIDECAR_CHECK_INTERVAL_MS) {
    return _sidecarAvailable;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${ZILLIZ_SERVICE_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await response.json() as { status: string; model_loaded: boolean };
    _sidecarAvailable = data.status === 'ok' && data.model_loaded === true;
  } catch {
    _sidecarAvailable = false;
  }

  _sidecarCheckTime = now;
  return _sidecarAvailable;
}

/**
 * Call the Zilliz highlight sidecar service
 */
async function callZillizService(
  question: string,
  context: string,
  threshold: number,
): Promise<HighlightResult | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${ZILLIZ_SERVICE_URL}/highlight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        context,
        threshold,
        return_sentence_metrics: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as {
      highlighted_sentences: string[];
      compression_rate: number;
      sentence_probabilities: number[];
    };

    // Count original sentences for stats
    const originalSentences = splitIntoSentences(context);

    return {
      highlightedSentences: data.highlighted_sentences,
      compressionRate: data.compression_rate,
      sentenceProbabilities: data.sentence_probabilities,
      originalSentenceCount: originalSentences.length,
      highlightedSentenceCount: data.highlighted_sentences.length,
    };
  } catch {
    return null;
  }
}

/**
 * Semantic Highlighter
 * Scores and highlights relevant sentences based on query
 *
 * Scoring chain: Zilliz sidecar → Voyage embeddings → term overlap
 */
export class SemanticHighlighter {
  private config: Required<SemanticHighlightConfig>;
  private embeddingGenerator?: IEmbeddingGenerator;

  constructor(config?: Partial<SemanticHighlightConfig>, embeddingGenerator?: IEmbeddingGenerator) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingGenerator = embeddingGenerator;
  }

  /**
   * Set the embedding generator (for semantic similarity)
   */
  setEmbeddingGenerator(generator: IEmbeddingGenerator): void {
    this.embeddingGenerator = generator;
  }

  /**
   * Highlight relevant sentences in content based on query
   * Tries Zilliz model first, falls back to embeddings, then term overlap
   */
  async highlight(query: string, content: string, threshold?: number): Promise<HighlightResult> {
    const effectiveThreshold = threshold ?? this.config.threshold;

    if (!content || content.trim().length === 0) {
      return {
        highlightedSentences: [],
        compressionRate: 1,
        sentenceProbabilities: [],
        originalSentenceCount: 0,
        highlightedSentenceCount: 0,
      };
    }

    // Priority 1: Try Zilliz sidecar service (the real deal - 0.6B encoder model)
    if (this.config.model === 'zilliz' || this.config.model === 'auto') {
      const sidecarUp = await checkSidecarAvailable();
      if (sidecarUp) {
        const result = await callZillizService(query, content, effectiveThreshold);
        if (result) return result;
      }
    }

    // Priority 2 & 3: Local scoring (embeddings or term overlap)
    return this.highlightLocal(query, content, effectiveThreshold);
  }

  /**
   * Local highlighting using embeddings or term overlap
   */
  private async highlightLocal(query: string, content: string, threshold: number): Promise<HighlightResult> {
    const sentences = splitIntoSentences(content);

    if (sentences.length === 0) {
      return {
        highlightedSentences: [],
        compressionRate: 1,
        sentenceProbabilities: [],
        originalSentenceCount: 0,
        highlightedSentenceCount: 0,
      };
    }

    const limitedSentences = this.config.maxSentences
      ? sentences.slice(0, this.config.maxSentences)
      : sentences;

    // Calculate relevance probabilities
    const probabilities = await this.calculateProbabilities(query, limitedSentences);

    // Filter by threshold
    const highlighted: string[] = [];
    const highlightedProbs: number[] = [];

    for (let i = 0; i < limitedSentences.length; i++) {
      if (probabilities[i] >= threshold) {
        highlighted.push(limitedSentences[i]);
        highlightedProbs.push(probabilities[i]);
      }
    }

    // Calculate compression rate
    const originalLength = content.length;
    const highlightedLength = highlighted.join(' ').length;
    const compressionRate = originalLength > 0 ? highlightedLength / originalLength : 0;

    return {
      highlightedSentences: highlighted,
      compressionRate,
      sentenceProbabilities: highlightedProbs,
      originalSentenceCount: sentences.length,
      highlightedSentenceCount: highlighted.length,
    };
  }

  /**
   * Calculate relevance probabilities for sentences
   */
  private async calculateProbabilities(query: string, sentences: string[]): Promise<number[]> {
    // Use semantic embeddings if available
    if (this.embeddingGenerator) {
      return this.calculateSemanticProbabilities(query, sentences);
    }

    // Fallback to term overlap
    return sentences.map(sentence => calculateTermOverlap(query, sentence));
  }

  /**
   * Calculate semantic similarity using embeddings
   */
  private async calculateSemanticProbabilities(query: string, sentences: string[]): Promise<number[]> {
    try {
      // Generate query embedding
      const queryEmbedding = await this.embeddingGenerator!.generateEmbedding(query);

      // Check if generator supports batch
      const generator = this.embeddingGenerator as { generateBatchEmbeddings?: (texts: string[]) => Promise<number[][]> };
      let sentenceEmbeddings: number[][];

      if (typeof generator.generateBatchEmbeddings === 'function') {
        sentenceEmbeddings = await generator.generateBatchEmbeddings(sentences);
      } else {
        // Fall back to sequential
        sentenceEmbeddings = await Promise.all(
          sentences.map(s => this.embeddingGenerator!.generateEmbedding(s))
        );
      }

      // Calculate cosine similarities
      return sentenceEmbeddings.map(embedding =>
        Math.max(0, cosineSimilarity(queryEmbedding, embedding))
      );
    } catch (error) {
      console.warn('Semantic highlighting failed, falling back to term overlap:', error);
      return sentences.map(sentence => calculateTermOverlap(query, sentence));
    }
  }

  /**
   * Highlight and return formatted output
   */
  async highlightFormatted(query: string, content: string, threshold?: number): Promise<string> {
    const result = await this.highlight(query, content, threshold);
    return result.highlightedSentences.join(' ');
  }

  /**
   * Get highlighting statistics
   */
  async getStats(query: string, content: string, threshold?: number): Promise<{
    originalTokens: number;
    highlightedTokens: number;
    tokenSavings: number;
    compressionRate: number;
    sentencesKept: number;
    sentencesRemoved: number;
  }> {
    const result = await this.highlight(query, content, threshold);

    // Rough token estimation (chars / 4)
    const originalTokens = Math.ceil(content.length / 4);
    const highlightedTokens = Math.ceil(result.highlightedSentences.join(' ').length / 4);

    return {
      originalTokens,
      highlightedTokens,
      tokenSavings: originalTokens - highlightedTokens,
      compressionRate: result.compressionRate,
      sentencesKept: result.highlightedSentenceCount,
      sentencesRemoved: result.originalSentenceCount - result.highlightedSentenceCount,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SemanticHighlightConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if highlighting is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if the Zilliz sidecar service is available
   */
  async isZillizAvailable(): Promise<boolean> {
    return checkSidecarAvailable();
  }
}

/**
 * Create a semantic highlighter instance
 */
export function createSemanticHighlighter(
  config?: Partial<SemanticHighlightConfig>,
  embeddingGenerator?: IEmbeddingGenerator
): SemanticHighlighter {
  return new SemanticHighlighter(config, embeddingGenerator);
}

/**
 * Quick highlight function for one-off usage
 */
export async function quickHighlight(
  query: string,
  content: string,
  threshold: number = 0.5,
  embeddingGenerator?: IEmbeddingGenerator
): Promise<HighlightResult> {
  const highlighter = new SemanticHighlighter({ threshold }, embeddingGenerator);
  return highlighter.highlight(query, content);
}

/**
 * Reset the sidecar availability cache (for testing)
 */
export function resetSidecarCache(): void {
  _sidecarAvailable = null;
  _sidecarCheckTime = 0;
}
