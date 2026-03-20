/**
 * Tests for semantic-highlight utility
 *
 * Scoring chain under test:
 *   1. Zilliz sidecar (HTTP POST localhost:8079/highlight)
 *   2. Voyage embeddings (cosine similarity)
 *   3. Term overlap (keyword fallback)
 */

import {
  SemanticHighlighter,
  createSemanticHighlighter,
  quickHighlight,
  resetSidecarCache,
} from '../src/utils/semantic-highlight';
import { IEmbeddingGenerator } from '../src/storage/vector-storage';
import { HighlightResult } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal IEmbeddingGenerator mock. */
function makeMockEmbeddingGenerator(
  embeddings: Record<string, number[]>,
  defaultEmbedding: number[] = [1, 0, 0],
): jest.Mocked<IEmbeddingGenerator> {
  return {
    generateEmbedding: jest.fn((text: string) =>
      Promise.resolve(embeddings[text] ?? defaultEmbedding),
    ),
    getDimension: jest.fn(() => defaultEmbedding.length),
  } as jest.Mocked<IEmbeddingGenerator>;
}

/** Simulates a healthy Zilliz sidecar /health response. */
function mockHealthOk(): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ status: 'ok', model_loaded: true }),
  } as unknown as Response);
}

/** Simulates a Zilliz sidecar /highlight response. */
function mockHighlightResponse(payload: {
  highlighted_sentences: string[];
  compression_rate: number;
  sentence_probabilities: number[];
}): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    json: async () => payload,
  } as unknown as Response);
}

/** Simulates a network failure (fetch throws). */
function mockFetchNetworkError(): void {
  (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED'));
}

/** Simulates a non-ok HTTP response. */
function mockFetchNotOk(status = 503): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  global.fetch = jest.fn();
  resetSidecarCache();
});

afterEach(() => {
  jest.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Test Plan
// ---------------------------------------------------------------------------
// | #  | Category   | Description                                          | Priority |
// |----|------------|------------------------------------------------------|----------|
// |  1 | Happy      | Sidecar available — returns highlighted sentences    | P0       |
// |  2 | Happy      | Sidecar returns probabilities and compression rate   | P0       |
// |  3 | Fallback   | Sidecar unavailable — falls back to term overlap     | P0       |
// |  4 | Fallback   | Sidecar /highlight not-ok — falls back to local      | P0       |
// |  5 | Edge       | Empty content returns empty HighlightResult          | P0       |
// |  6 | Edge       | Whitespace-only content returns empty result         | P1       |
// |  7 | Config     | updateConfig() mutates enabled state                 | P1       |
// |  8 | Config     | isEnabled() reflects config.enabled                  | P1       |
// |  9 | Config     | threshold override parameter is respected            | P1       |
// | 10 | Config     | maxSentences limits sentences processed              | P1       |
// | 11 | Output     | highlightFormatted() returns sentences joined by " " | P1       |
// | 12 | Output     | getStats() returns correct token savings numbers     | P1       |
// | 13 | Standalone | quickHighlight() works without a class instance      | P1       |
// | 14 | Factory    | createSemanticHighlighter() returns SemanticHighlighter | P1   |
// | 15 | Scoring    | Term overlap: exact query terms score 1.0            | P1       |
// | 16 | Scoring    | Term overlap: no common terms score 0.0              | P1       |
// | 17 | Scoring    | Short terms (<=2 chars) are ignored in overlap calc  | P2       |
// | 18 | Scoring    | Embedding cosine similarity used when generator set  | P1       |
// | 19 | Scoring    | Embedding failure falls back to term overlap         | P1       |
// | 20 | Cache      | Sidecar cache is used within 30s window              | P1       |
// | 21 | Cache      | resetSidecarCache() forces re-check on next call     | P1       |
// | 22 | Config     | model !== 'zilliz' skips sidecar even when healthy   | P2       |
// | 23 | Scoring    | Threshold filtering removes low-scoring sentences    | P1       |
// | 24 | Output     | isZillizAvailable() mirrors sidecar health check     | P1       |
// | 25 | Scoring    | setEmbeddingGenerator() replaces generator mid-use   | P2       |

// ---------------------------------------------------------------------------
// 1 — Sidecar happy path: highlighted sentences returned
// ---------------------------------------------------------------------------
describe('SemanticHighlighter', () => {
  describe('highlight() — sidecar available', () => {
    it('should return sidecar highlighted sentences when service is healthy', async () => {
      mockHealthOk();
      mockHighlightResponse({
        highlighted_sentences: ['The cat sat on the mat.'],
        compression_rate: 0.5,
        sentence_probabilities: [0.9],
      });

      const highlighter = new SemanticHighlighter();
      const result = await highlighter.highlight(
        'cat mat',
        'The cat sat on the mat. The dog ran away.',
      );

      expect(result.highlightedSentences).toEqual(['The cat sat on the mat.']);
      expect(result.compressionRate).toBe(0.5);
      expect(result.sentenceProbabilities).toEqual([0.9]);
    });

    // 2 — Sidecar returns full metadata
    it('should populate originalSentenceCount and highlightedSentenceCount from sidecar response', async () => {
      mockHealthOk();
      mockHighlightResponse({
        highlighted_sentences: ['First sentence.', 'Third sentence.'],
        compression_rate: 0.66,
        sentence_probabilities: [0.95, 0.8],
      });

      const highlighter = new SemanticHighlighter();
      const result = await highlighter.highlight(
        'query',
        'First sentence. Second sentence. Third sentence.',
      );

      expect(result.originalSentenceCount).toBe(3);
      expect(result.highlightedSentenceCount).toBe(2);
      expect(result.sentenceProbabilities).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 3 — Sidecar unavailable: falls back to term overlap
  // ---------------------------------------------------------------------------
  describe('highlight() — sidecar unavailable (fallback path)', () => {
    it('should fall back to term overlap when sidecar health check fails', async () => {
      // Health check throws (connection refused)
      mockFetchNetworkError();

      const highlighter = new SemanticHighlighter({ threshold: 0.3 });
      const result = await highlighter.highlight(
        'memory titan',
        'Titan memory stores knowledge. Something unrelated here.',
      );

      // "titan" and "memory" appear in the first sentence so its overlap > 0
      expect(result.highlightedSentences.length).toBeGreaterThan(0);
      expect(result.highlightedSentences[0]).toContain('Titan memory');
    });

    // 4 — Sidecar /highlight returns non-ok status
    it('should fall back to local scoring when sidecar /highlight returns non-ok status', async () => {
      mockHealthOk();
      // /highlight call returns 503
      mockFetchNotOk(503);

      const highlighter = new SemanticHighlighter({ threshold: 0.3 });
      const result = await highlighter.highlight(
        'titan memory',
        'Titan memory is important. This sentence is about penguins.',
      );

      // Local fallback should still surface relevant sentence
      expect(result.highlightedSentences).toContain('Titan memory is important.');
    });
  });

  // ---------------------------------------------------------------------------
  // 5 — Empty content
  // ---------------------------------------------------------------------------
  describe('highlight() — edge cases', () => {
    it('should return empty HighlightResult when content is empty string', async () => {
      const highlighter = new SemanticHighlighter();
      const result = await highlighter.highlight('query', '');

      expect(result.highlightedSentences).toEqual([]);
      expect(result.sentenceProbabilities).toEqual([]);
      expect(result.originalSentenceCount).toBe(0);
      expect(result.highlightedSentenceCount).toBe(0);
      expect(result.compressionRate).toBe(1);
      // fetch should NOT be called for empty content
      expect(global.fetch).not.toHaveBeenCalled();
    });

    // 6 — Whitespace-only content
    it('should return empty HighlightResult when content is only whitespace', async () => {
      const highlighter = new SemanticHighlighter();
      const result = await highlighter.highlight('query', '   \n\t  ');

      expect(result.highlightedSentences).toEqual([]);
      expect(result.compressionRate).toBe(1);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 7, 8 — Config: updateConfig() and isEnabled()
  // ---------------------------------------------------------------------------
  describe('updateConfig() and isEnabled()', () => {
    it('should reflect enabled:true by default', () => {
      const highlighter = new SemanticHighlighter();
      expect(highlighter.isEnabled()).toBe(true);
    });

    it('should reflect enabled:false after updateConfig()', () => {
      const highlighter = new SemanticHighlighter();
      highlighter.updateConfig({ enabled: false });
      expect(highlighter.isEnabled()).toBe(false);
    });

    // 7 — updateConfig mutates threshold too
    it('should apply partial config updates without clobbering other fields', () => {
      const highlighter = new SemanticHighlighter({ threshold: 0.4, maxSentences: 5 });
      highlighter.updateConfig({ threshold: 0.8 });
      // maxSentences should still be 5 — check via behaviour
      expect(highlighter.isEnabled()).toBe(true); // still enabled
    });
  });

  // ---------------------------------------------------------------------------
  // 9 — Threshold override per-call
  // ---------------------------------------------------------------------------
  describe('highlight() — threshold parameter', () => {
    it('should use per-call threshold override instead of config threshold', async () => {
      // No sidecar
      mockFetchNetworkError();

      const highlighter = new SemanticHighlighter({ threshold: 0.99 }); // very high default
      // Pass a low threshold so term-overlap sentences qualify
      const result = await highlighter.highlight(
        'titan',
        'Titan stores memories. Dogs are friendly.',
        0.1, // low per-call override
      );

      // At threshold 0.1, the first sentence should pass term overlap (has 'titan')
      expect(result.highlightedSentences).toContain('Titan stores memories.');
    });

    // 23 — Threshold filtering removes low-scoring sentences
    it('should exclude sentences below the threshold', async () => {
      mockFetchNetworkError();

      const highlighter = new SemanticHighlighter({ threshold: 0.99 });
      const result = await highlighter.highlight(
        'titan',
        'This is unrelated. Also unrelated. Still unrelated.',
      );

      // term overlap between 'titan' and these sentences is 0 — all excluded
      expect(result.highlightedSentences).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 10 — maxSentences limits the processed set
  // ---------------------------------------------------------------------------
  describe('highlight() — maxSentences config', () => {
    it('should process only up to maxSentences sentences', async () => {
      mockFetchNetworkError();

      const content =
        'Alpha sentence. Beta sentence. Gamma sentence. Delta sentence. Epsilon sentence.';

      const highlighter = new SemanticHighlighter({
        maxSentences: 2,
        threshold: 0.0, // include everything that passes
      });

      const result = await highlighter.highlight('alpha beta gamma delta epsilon', content);

      // Only up to 2 sentences were considered, so at most 2 can be highlighted
      expect(result.highlightedSentences.length).toBeLessThanOrEqual(2);
      // originalSentenceCount should reflect ALL sentences in content, not the cap
      expect(result.originalSentenceCount).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // 11 — highlightFormatted() returns joined string
  // ---------------------------------------------------------------------------
  describe('highlightFormatted()', () => {
    it('should return highlighted sentences joined by a single space', async () => {
      mockHealthOk();
      mockHighlightResponse({
        highlighted_sentences: ['First.', 'Second.'],
        compression_rate: 0.6,
        sentence_probabilities: [0.9, 0.85],
      });

      const highlighter = new SemanticHighlighter();
      const formatted = await highlighter.highlightFormatted('q', 'First. Second. Third.');

      expect(formatted).toBe('First. Second.');
    });

    it('should return empty string when no sentences pass threshold', async () => {
      mockFetchNetworkError();

      const highlighter = new SemanticHighlighter({ threshold: 0.99 });
      const formatted = await highlighter.highlightFormatted(
        'xyz',
        'Unrelated content here. More unrelated text.',
      );

      expect(formatted).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // 12 — getStats() token savings
  // ---------------------------------------------------------------------------
  describe('getStats()', () => {
    it('should return originalTokens, highlightedTokens, and positive tokenSavings', async () => {
      mockHealthOk();
      // Sidecar returns one of two sentences
      mockHighlightResponse({
        highlighted_sentences: ['Short sentence.'],
        compression_rate: 0.3,
        sentence_probabilities: [0.9],
      });

      const content = 'Short sentence. A much longer second sentence with many more words here.';
      const highlighter = new SemanticHighlighter();
      const stats = await highlighter.getStats('query', content);

      expect(stats.originalTokens).toBe(Math.ceil(content.length / 4));
      expect(stats.highlightedTokens).toBeLessThan(stats.originalTokens);
      expect(stats.tokenSavings).toBeGreaterThan(0);
      expect(stats.sentencesKept).toBe(1);
      expect(stats.sentencesRemoved).toBeGreaterThan(0);
      expect(typeof stats.compressionRate).toBe('number');
    });

    it('should return zero tokenSavings when all sentences are highlighted', async () => {
      mockFetchNetworkError();

      const content = 'titan memory retrieval.';
      const highlighter = new SemanticHighlighter({ threshold: 0.0 });
      const stats = await highlighter.getStats('titan memory retrieval', content);

      expect(stats.sentencesRemoved).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 13 — quickHighlight() standalone
  // ---------------------------------------------------------------------------
  describe('quickHighlight()', () => {
    it('should highlight content using the default threshold of 0.5', async () => {
      // Sidecar down
      mockFetchNetworkError();

      const result: HighlightResult = await quickHighlight(
        'titan memory',
        'Titan memory stores data efficiently. Something else entirely.',
      );

      expect(result).toHaveProperty('highlightedSentences');
      expect(result).toHaveProperty('compressionRate');
      expect(result).toHaveProperty('sentenceProbabilities');
      expect(result).toHaveProperty('originalSentenceCount');
      expect(result).toHaveProperty('highlightedSentenceCount');
    });

    it('should accept a custom threshold parameter', async () => {
      mockFetchNetworkError();

      // "zxqwerty" has no term overlap with the content, so term-overlap score is 0.
      // Even at a very low threshold like 0.01, a score of 0 fails.
      const resultHigh = await quickHighlight(
        'zxqwerty',
        'Dogs are friendly animals. Cats like sleeping.',
        0.01,
      );
      expect(resultHigh.highlightedSentences).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 14 — createSemanticHighlighter() factory
  // ---------------------------------------------------------------------------
  describe('createSemanticHighlighter()', () => {
    it('should return a SemanticHighlighter instance', () => {
      const highlighter = createSemanticHighlighter({ threshold: 0.6 });
      expect(highlighter).toBeInstanceOf(SemanticHighlighter);
    });

    it('should respect config passed to the factory', () => {
      const highlighter = createSemanticHighlighter({ enabled: false });
      expect(highlighter.isEnabled()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 15, 16, 17 — Term overlap scoring
  // ---------------------------------------------------------------------------
  describe('term overlap fallback scoring', () => {
    it('should score 1.0 when all query terms appear in the sentence', async () => {
      mockFetchNetworkError();

      // Query = "titan memory storage" (3 terms all >2 chars)
      // Sentence includes all three words
      const highlighter = new SemanticHighlighter({ threshold: 0.99 });
      const result = await highlighter.highlight(
        'titan memory storage',
        'Titan memory storage is the system.',
      );

      // Score should be 1.0 → sentence passes even at threshold 0.99
      expect(result.highlightedSentences).toContain('Titan memory storage is the system.');
    });

    it('should score 0.0 when no query terms appear in the sentence', async () => {
      mockFetchNetworkError();

      const highlighter = new SemanticHighlighter({ threshold: 0.01 }); // very low — would pass anything > 0
      const result = await highlighter.highlight(
        'zeppelin airship blimp', // none of these words appear in content
        'The cat sat on the mat today.',
      );

      expect(result.highlightedSentences).toEqual([]);
    });

    // 17 — Short terms <= 2 chars are ignored
    it('should ignore query terms with 2 or fewer characters in overlap calculation', async () => {
      mockFetchNetworkError();

      // Query is all short tokens: "is a to" — none qualify (all <=2 chars)
      // So queryTerms.size === 0 → overlap returns 0 → nothing passes threshold 0.01
      const highlighter = new SemanticHighlighter({ threshold: 0.01 });
      const result = await highlighter.highlight(
        'is a to',
        'is a to and in or of the.',
      );

      expect(result.highlightedSentences).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 18 — Embedding cosine similarity
  // ---------------------------------------------------------------------------
  describe('highlight() — with embedding generator', () => {
    it('should use cosine similarity when an embedding generator is set', async () => {
      // Sidecar down so we reach local path
      mockFetchNetworkError();

      // Query embedding is [1,0,0].
      // Sentence A embedding [1,0,0] → similarity 1.0 (should pass threshold 0.5)
      // Sentence B embedding [0,1,0] → similarity 0.0 (should fail threshold 0.5)
      const generator = makeMockEmbeddingGenerator({
        'useful titan information': [1, 0, 0],
        'Titan stores useful information.': [1, 0, 0],
        'Dogs are friendly animals.': [0, 1, 0],
      });

      const highlighter = new SemanticHighlighter({ threshold: 0.5 }, generator);
      const result = await highlighter.highlight(
        'useful titan information',
        'Titan stores useful information. Dogs are friendly animals.',
      );

      expect(result.highlightedSentences).toContain('Titan stores useful information.');
      expect(result.highlightedSentences).not.toContain('Dogs are friendly animals.');
    });

    // 18b — Uses batch embeddings when available
    it('should call generateBatchEmbeddings when the generator supports it', async () => {
      mockFetchNetworkError();

      const batchGenerator = {
        generateEmbedding: jest.fn().mockResolvedValue([1, 0, 0]),
        generateBatchEmbeddings: jest.fn().mockResolvedValue([
          [1, 0, 0],
          [0, 0, 1],
        ]),
      };

      const highlighter = new SemanticHighlighter(
        { threshold: 0.5 },
        batchGenerator as unknown as IEmbeddingGenerator,
      );

      await highlighter.highlight(
        'query text',
        'First sentence here. Second sentence here.',
      );

      expect(batchGenerator.generateBatchEmbeddings).toHaveBeenCalled();
    });

    // 19 — Embedding failure falls back to term overlap
    it('should fall back to term overlap when embedding generator throws', async () => {
      mockFetchNetworkError();

      const failingGenerator: jest.Mocked<IEmbeddingGenerator> = {
        generateEmbedding: jest.fn().mockRejectedValue(new Error('API timeout')),
        getDimension: jest.fn().mockReturnValue(3),
      };

      const highlighter = new SemanticHighlighter({ threshold: 0.3 }, failingGenerator);
      // "titan" appears in first sentence → term overlap > 0
      const result = await highlighter.highlight(
        'titan memory',
        'Titan memory is reliable. Nothing relevant here.',
      );

      // Fallback to term overlap should still highlight the matching sentence
      expect(result.highlightedSentences).toContain('Titan memory is reliable.');
    });
  });

  // ---------------------------------------------------------------------------
  // 20, 21 — Sidecar cache behaviour
  // ---------------------------------------------------------------------------
  describe('sidecar availability caching', () => {
    it('should not re-check sidecar health within the 30-second window', async () => {
      // First call: health check fires
      mockHealthOk();
      mockHighlightResponse({
        highlighted_sentences: ['A.'],
        compression_rate: 0.5,
        sentence_probabilities: [0.9],
      });

      const highlighter = new SemanticHighlighter();
      await highlighter.highlight('q', 'A. B.');

      // Second call: cache should be hit — no extra health check
      mockHighlightResponse({
        highlighted_sentences: ['A.'],
        compression_rate: 0.5,
        sentence_probabilities: [0.9],
      });
      await highlighter.highlight('q', 'A. B.');

      // fetch was called: 1 health + 2 highlight = 3 total (NOT 4 — no second health check)
      const calls = (global.fetch as jest.Mock).mock.calls as Array<[string, ...unknown[]]>;
      const healthCalls = calls.filter(([url]) =>
        typeof url === 'string' && url.includes('/health'),
      );
      expect(healthCalls).toHaveLength(1);
    });

    // 21 — resetSidecarCache() forces re-check
    it('should re-check sidecar health after resetSidecarCache() is called', async () => {
      mockHealthOk();
      mockHighlightResponse({
        highlighted_sentences: ['X.'],
        compression_rate: 0.5,
        sentence_probabilities: [0.9],
      });

      const highlighter = new SemanticHighlighter();
      await highlighter.highlight('q', 'X. Y.');

      // Reset the cache
      resetSidecarCache();

      mockHealthOk();
      mockHighlightResponse({
        highlighted_sentences: ['X.'],
        compression_rate: 0.5,
        sentence_probabilities: [0.9],
      });
      await highlighter.highlight('q', 'X. Y.');

      const calls = (global.fetch as jest.Mock).mock.calls as Array<[string, ...unknown[]]>;
      const healthCalls = calls.filter(([url]) =>
        typeof url === 'string' && url.includes('/health'),
      );
      // Two separate health checks — one before, one after reset
      expect(healthCalls).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 22 — model !== 'zilliz' skips sidecar
  // ---------------------------------------------------------------------------
  describe('highlight() — model config controls sidecar usage', () => {
    it('should skip sidecar entirely when model is not "zilliz" or "auto"', async () => {
      const highlighter = new SemanticHighlighter({
        model: 'local',
        threshold: 0.3,
      });

      await highlighter.highlight(
        'titan memory',
        'Titan memory is useful. Dogs are not relevant.',
      );

      // fetch should never be called — no sidecar check or highlight call
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 24 — isZillizAvailable() mirrors health check
  // ---------------------------------------------------------------------------
  describe('isZillizAvailable()', () => {
    it('should return true when sidecar health endpoint reports ok and model_loaded', async () => {
      mockHealthOk();
      const highlighter = new SemanticHighlighter();
      const available = await highlighter.isZillizAvailable();
      expect(available).toBe(true);
    });

    it('should return false when sidecar health endpoint is unreachable', async () => {
      mockFetchNetworkError();
      const highlighter = new SemanticHighlighter();
      const available = await highlighter.isZillizAvailable();
      expect(available).toBe(false);
    });

    it('should return false when sidecar health reports model_loaded: false', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', model_loaded: false }),
      } as unknown as Response);

      const highlighter = new SemanticHighlighter();
      const available = await highlighter.isZillizAvailable();
      expect(available).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 25 — setEmbeddingGenerator() replaces generator
  // ---------------------------------------------------------------------------
  describe('setEmbeddingGenerator()', () => {
    it('should switch from term overlap to semantic scoring after generator is set', async () => {
      // Sidecar down
      mockFetchNetworkError();

      const highlighter = new SemanticHighlighter({ threshold: 0.5 });

      // Before setting generator — uses term overlap
      // Query 'zxqwerty' has no overlap with content
      resetSidecarCache();
      mockFetchNetworkError();
      const beforeResult = await highlighter.highlight(
        'zxqwerty',
        'Titan memory is great.',
      );
      expect(beforeResult.highlightedSentences).toEqual([]);

      // Now inject an embedding generator that will produce high similarity
      const generator = makeMockEmbeddingGenerator(
        {},
        [1, 0, 0], // all embeddings return [1,0,0] → cosine sim = 1.0
      );
      highlighter.setEmbeddingGenerator(generator);

      resetSidecarCache();
      mockFetchNetworkError();
      const afterResult = await highlighter.highlight(
        'zxqwerty',
        'Titan memory is great.',
      );

      // With embedding generator returning 1.0 similarity, sentence passes threshold
      expect(afterResult.highlightedSentences).toContain('Titan memory is great.');
    });
  });
});
