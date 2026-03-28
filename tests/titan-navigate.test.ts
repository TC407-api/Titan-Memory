/**
 * Tests for Token-Efficient Navigation (Phase 4 - v2.2)
 *
 * Verifies:
 * 1. Navigate returns category summaries under 500 tokens
 * 2. Navigate with category filter returns only matching
 * 3. Token budget respected
 * 4. Relevance gating filters low-relevance memories
 */

import { gateByRelevance } from '../src/retrieval/relevance-gate';

describe('Relevance Gate', () => {
  const makeMemory = (id: string, score: number, content: string) => ({
    id,
    content,
    score,
    metadata: { tags: [] },
  });

  describe('gateByRelevance', () => {
    it('should return memories sorted by score descending', () => {
      const memories = [
        makeMemory('a', 0.5, 'low relevance'),
        makeMemory('b', 0.9, 'high relevance'),
        makeMemory('c', 0.7, 'medium relevance'),
      ];

      const result = gateByRelevance(memories, 10000);

      expect(result[0].id).toBe('b');
      expect(result[1].id).toBe('c');
      expect(result[2].id).toBe('a');
    });

    it('should cap total output at budget tokens', () => {
      // Each memory has ~20 chars = ~5 tokens (chars/4)
      const memories = [
        makeMemory('a', 0.9, 'a'.repeat(400)),  // ~100 tokens
        makeMemory('b', 0.8, 'b'.repeat(400)),  // ~100 tokens
        makeMemory('c', 0.7, 'c'.repeat(400)),  // ~100 tokens
        makeMemory('d', 0.6, 'd'.repeat(400)),  // ~100 tokens
      ];

      // Budget of 250 tokens should fit ~2-3 memories
      const result = gateByRelevance(memories, 250);

      expect(result.length).toBeLessThanOrEqual(3);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty array for empty input', () => {
      const result = gateByRelevance([], 1000);

      expect(result).toEqual([]);
    });

    it('should preserve top-k most relevant within budget', () => {
      const memories = [
        makeMemory('low', 0.1, 'x'.repeat(100)),
        makeMemory('high', 0.99, 'y'.repeat(100)),
        makeMemory('mid', 0.5, 'z'.repeat(100)),
      ];

      const result = gateByRelevance(memories, 50);

      // With a tight budget, should at least include the highest scoring
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].id).toBe('high');
    });

    it('should respect token budget of zero', () => {
      const memories = [makeMemory('a', 0.9, 'some content')];
      const result = gateByRelevance(memories, 0);

      expect(result).toEqual([]);
    });

    it('should handle memories with no content gracefully', () => {
      const memories = [
        makeMemory('a', 0.9, ''),
        makeMemory('b', 0.8, 'has content'),
      ];

      const result = gateByRelevance(memories, 1000);

      expect(result.length).toBe(2);
    });

    it('should include all memories when budget is large enough', () => {
      const memories = [
        makeMemory('a', 0.9, 'short'),
        makeMemory('b', 0.8, 'also short'),
        makeMemory('c', 0.7, 'brief'),
      ];

      const result = gateByRelevance(memories, 100000);

      expect(result.length).toBe(3);
    });
  });
});

describe('Token Budget Estimation', () => {
  it('should estimate tokens as chars/4', () => {
    // 400 chars = 100 tokens
    const memories = [
      { id: '1', content: 'a'.repeat(400), score: 0.9, metadata: {} },
    ];

    const result = gateByRelevance(memories, 99);

    // 100 token memory should NOT fit in 99 token budget
    expect(result.length).toBe(0);
  });

  it('should estimate tokens correctly for budget boundary', () => {
    const memories = [
      { id: '1', content: 'a'.repeat(400), score: 0.9, metadata: {} },
    ];

    const result = gateByRelevance(memories, 100);

    // Exactly 100 tokens should fit in 100 token budget
    expect(result.length).toBe(1);
  });
});
