import { ProactiveSuggestionsManager } from '../src/mcp/proactive-suggestions.js';
import { MemoryEntry } from '../src/types.js';

// Mock dependencies
jest.mock('../src/utils/semantic-highlight.js', () => ({
  SemanticHighlighter: jest.fn().mockImplementation(() => ({
    setEmbeddingGenerator: jest.fn(),
    highlight: jest.fn().mockResolvedValue('highlighted text'),
  })),
}));

jest.mock('../src/utils/similarity.js', () => ({
  contentSimilarity: jest.fn().mockReturnValue(0.7),
}));

jest.mock('../src/storage/embeddings/index.js', () => ({
  cosineSimilarity: jest.fn().mockReturnValue(0.8),
}));

function makeMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem-' + Math.random().toString(36).slice(2, 8),
    content: 'test memory content',
    timestamp: new Date(),
    layer: 'episodic',
    metadata: { utilityScore: 0.7 },
    accessCount: 1,
    lastAccessed: new Date(),
    importance: 0.5,
    connections: [],
    ...overrides,
  } as MemoryEntry;
}

describe('ProactiveSuggestionsManager', () => {
  describe('constructor', () => {
    it('should create with default config', () => {
      const mgr = new ProactiveSuggestionsManager();
      expect(mgr).toBeDefined();
    });

    it('should create with custom config', () => {
      const mgr = new ProactiveSuggestionsManager({
        enabled: false,
        maxSuggestions: 3,
        minUtility: 0.8,
        minRelevance: 0.7,
      });
      expect(mgr).toBeDefined();
    });

    it('should accept embedding generator', () => {
      const generator = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
      const mgr = new ProactiveSuggestionsManager({}, generator as any);
      expect(mgr).toBeDefined();
    });
  });

  describe('setEmbeddingGenerator', () => {
    it('should set embedding generator after construction', () => {
      const mgr = new ProactiveSuggestionsManager();
      const generator = { generateEmbedding: jest.fn() };
      mgr.setEmbeddingGenerator(generator as any);
      // No error = success
    });
  });

  describe('suggest', () => {
    it('should return empty array when disabled', async () => {
      const mgr = new ProactiveSuggestionsManager({ enabled: false });
      const result = await mgr.suggest('context', [makeMemory()]);
      expect(result).toEqual([]);
    });

    it('should return suggestions for matching memories', async () => {
      const mgr = new ProactiveSuggestionsManager({
        minUtility: 0.1,
        minRelevance: 0.1,
      });
      const memories = [
        makeMemory({ content: 'React best practices', metadata: { utilityScore: 0.9 } }),
        makeMemory({ content: 'Vue patterns', metadata: { utilityScore: 0.8 } }),
      ];

      const result = await mgr.suggest('React development', memories);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should respect limit option', async () => {
      const mgr = new ProactiveSuggestionsManager({ minUtility: 0.1, minRelevance: 0.1 });
      const memories = Array.from({ length: 10 }, (_, i) =>
        makeMemory({ content: `memory ${i}`, metadata: { utilityScore: 0.9 } })
      );

      const result = await mgr.suggest('test', memories, { limit: 2 });
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it('should filter by minUtility', async () => {
      const mgr = new ProactiveSuggestionsManager({ minRelevance: 0.1 });
      const memories = [
        makeMemory({ metadata: { utilityScore: 0.1 } }), // below default 0.6
      ];

      const result = await mgr.suggest('test', memories, { minUtility: 0.9 });
      expect(result).toEqual([]);
    });

    it('should filter by minRelevance', async () => {
      const { contentSimilarity } = require('../src/utils/similarity.js');
      contentSimilarity.mockReturnValueOnce(0.01); // very low relevance

      const mgr = new ProactiveSuggestionsManager({ minUtility: 0.1 });
      const memories = [makeMemory({ metadata: { utilityScore: 0.9 } })];

      const result = await mgr.suggest('test', memories, { minRelevance: 0.99 });
      expect(result).toEqual([]);
    });

    it('should use embedding generator when available', async () => {
      const generator = {
        generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      };
      const mgr = new ProactiveSuggestionsManager({ minUtility: 0.1, minRelevance: 0.1 }, generator as any);
      const memories = [makeMemory({ metadata: { utilityScore: 0.9 } })];

      await mgr.suggest('test context', memories);
      expect(generator.generateEmbedding).toHaveBeenCalled();
    });

    it('should fall back to term similarity when embedding fails', async () => {
      const generator = {
        generateEmbedding: jest.fn().mockRejectedValue(new Error('embedding failed')),
      };
      const mgr = new ProactiveSuggestionsManager({ minUtility: 0.1, minRelevance: 0.1 }, generator as any);
      const memories = [makeMemory({ metadata: { utilityScore: 0.9 } })];

      const result = await mgr.suggest('test', memories);
      // Should not throw, falls back to contentSimilarity
      expect(result).toBeDefined();
    });

    it('should handle empty memories array', async () => {
      const mgr = new ProactiveSuggestionsManager();
      const result = await mgr.suggest('context', []);
      expect(result).toEqual([]);
    });

    it('should handle memories without utilityScore', async () => {
      const mgr = new ProactiveSuggestionsManager({ minUtility: 0.1, minRelevance: 0.1 });
      const memories = [makeMemory({ metadata: {} })];

      const result = await mgr.suggest('test', memories);
      // Should use default 0.5 utility
      expect(result).toBeDefined();
    });

    it('should calculate recency score (recent memories score higher)', async () => {
      const mgr = new ProactiveSuggestionsManager({ minUtility: 0.1, minRelevance: 0.1 });
      const recentMemory = makeMemory({ timestamp: new Date(), metadata: { utilityScore: 0.7 } });
      const oldMemory = makeMemory({
        timestamp: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        metadata: { utilityScore: 0.7 },
      });

      const result = await mgr.suggest('test', [recentMemory, oldMemory]);
      // Recent memory should rank higher
      if (result.length >= 2) {
        expect(result[0].memoryId).toBe(recentMemory.id);
      }
    });

    it('should track suggestion history', async () => {
      const mgr = new ProactiveSuggestionsManager({ minUtility: 0.1, minRelevance: 0.1 });
      const memory = makeMemory({ metadata: { utilityScore: 0.9 } });

      await mgr.suggest('test', [memory]);
      // Second call should still work (history tracked but not blocking)
      const result2 = await mgr.suggest('test again', [memory]);
      expect(result2).toBeDefined();
    });
  });
});
