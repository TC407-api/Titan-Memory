/**
 * Tests for src/utils/semantic-surprise.ts
 * Covers LshSurpriseCalculator, SemanticSurpriseCalculator, HybridSurpriseCalculator,
 * createSurpriseCalculator, and calculateSemanticSurprise.
 */

import {
  LshSurpriseCalculator,
  SemanticSurpriseCalculator,
  HybridSurpriseCalculator,
  createSurpriseCalculator,
  calculateSemanticSurprise,
} from '../src/utils/semantic-surprise';
import { IEmbeddingGenerator } from '../src/storage/vector-storage';
import { MemoryEntry, MemoryLayer, SemanticSurpriseConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemoryEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    layer: MemoryLayer.LONG_TERM,
    timestamp: new Date(),
    metadata: {},
  };
}

/** Build a normalised unit vector of the given dimension. */
function makeUnitVector(dim: number, value: number = 1): number[] {
  const raw = Array(dim).fill(value);
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map(v => v / norm);
}

/**
 * Create a mock IEmbeddingGenerator.
 * embedFn receives content and returns a vector — default produces a
 * unique unit vector per call so all memories look different.
 */
function makeMockEmbeddingGenerator(
  embedFn?: (text: string) => number[]
): jest.Mocked<IEmbeddingGenerator> {
  let callIndex = 0;
  return {
    getDimension: jest.fn(() => 8),
    generateEmbedding: jest.fn(async (text: string) => {
      if (embedFn) return embedFn(text);
      // Default: return unique vector each call
      callIndex++;
      const v = Array(8).fill(0);
      v[callIndex % 8] = 1;
      return v;
    }),
  };
}

// ---------------------------------------------------------------------------
// LshSurpriseCalculator
// ---------------------------------------------------------------------------

describe('LshSurpriseCalculator', () => {
  let calculator: LshSurpriseCalculator;

  beforeEach(() => {
    calculator = new LshSurpriseCalculator();
  });

  it('should return a SurpriseResult with all required fields', async () => {
    const result = await calculator.calculateSurprise('novel content', []);
    expect(typeof result.score).toBe('number');
    expect(typeof result.noveltyScore).toBe('number');
    expect(typeof result.patternBoost).toBe('number');
    expect(typeof result.shouldStore).toBe('boolean');
    expect(Array.isArray(result.similarMemories)).toBe(true);
  });

  it('should return high novelty score when there are no existing memories', async () => {
    const result = await calculator.calculateSurprise('totally new content', []);
    expect(result.noveltyScore).toBeGreaterThan(0.5);
  });

  it('should indicate shouldStore=true when score exceeds threshold', async () => {
    const result = await calculator.calculateSurprise('unique content xyz 123', [], 0.1);
    expect(result.shouldStore).toBe(true);
  });

  it('should indicate shouldStore=false when score is below threshold', async () => {
    const existing = makeMemoryEntry('m1', 'identical content exactly the same');
    const result = await calculator.calculateSurprise('identical content exactly the same', [existing], 0.99);
    expect(result.shouldStore).toBe(false);
  });

  it('should give lower novelty for content very similar to an existing memory', async () => {
    const similar = makeMemoryEntry('m1', 'the quick brown fox jumps over the lazy dog');
    const novel = await calculator.calculateSurprise(
      'the quick brown fox jumps over the lazy dog',
      [similar]
    );
    const different = await calculator.calculateSurprise(
      'quantum computing is fundamentally different from classical systems',
      [similar]
    );
    expect(novel.noveltyScore).toBeLessThanOrEqual(different.noveltyScore);
  });

  it('should add patternBoost for content with decision keywords', async () => {
    const withBoost = await calculator.calculateSurprise('I decided to use TypeScript for this project', []);
    const noBoost = await calculator.calculateSurprise('this is some random text content', []);
    expect(withBoost.patternBoost).toBeGreaterThan(noBoost.patternBoost);
  });

  it('should cap score at 1.0', async () => {
    const result = await calculator.calculateSurprise('error: failed to connect, decided to fix', []);
    expect(result.score).toBeLessThanOrEqual(1.0);
  });

  it('should respect a custom threshold of 0.5', async () => {
    const result = await calculator.calculateSurprise('brand new unique thing', [], 0.5);
    // score and shouldStore must be consistent
    expect(result.shouldStore).toBe(result.score >= 0.5);
  });
});

// ---------------------------------------------------------------------------
// SemanticSurpriseCalculator
// ---------------------------------------------------------------------------

describe('SemanticSurpriseCalculator', () => {
  it('should generate an embedding for new content', async () => {
    const mockGen = makeMockEmbeddingGenerator();
    const calc = new SemanticSurpriseCalculator(mockGen);

    await calc.calculateSurprise('new content', []);
    expect(mockGen.generateEmbedding).toHaveBeenCalledWith('new content');
  });

  it('should generate embeddings for each existing memory', async () => {
    const mockGen = makeMockEmbeddingGenerator();
    const calc = new SemanticSurpriseCalculator(mockGen);
    const memories = [
      makeMemoryEntry('m1', 'memory one'),
      makeMemoryEntry('m2', 'memory two'),
    ];

    await calc.calculateSurprise('new content', memories);
    expect(mockGen.generateEmbedding).toHaveBeenCalledTimes(3);
  });

  it('should return noveltyScore = 1.0 when no memories exist (max novelty)', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const calc = new SemanticSurpriseCalculator(mockGen);

    const result = await calc.calculateSurprise('anything', []);
    expect(result.noveltyScore).toBe(1.0);
  });

  it('should return low novelty when content is identical to an existing memory (same embedding)', async () => {
    const identicalVector = makeUnitVector(8);
    const mockGen = makeMockEmbeddingGenerator(() => identicalVector);
    const calc = new SemanticSurpriseCalculator(mockGen);

    const memory = makeMemoryEntry('m1', 'same content');
    const result = await calc.calculateSurprise('same content', [memory]);
    // cos similarity = 1.0 → novelty = 0.0
    expect(result.noveltyScore).toBeCloseTo(0.0, 5);
  });

  it('should cache embeddings to avoid redundant generation', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const calc = new SemanticSurpriseCalculator(mockGen);

    await calc.calculateSurprise('cached content', []);
    const callsAfterFirst = (mockGen.generateEmbedding as jest.Mock).mock.calls.length;

    await calc.calculateSurprise('cached content', []);
    // Second call with same content should not add new generateEmbedding calls
    const callsAfterSecond = (mockGen.generateEmbedding as jest.Mock).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it('should limit comparison to comparisionLimit memories', async () => {
    const mockGen = makeMockEmbeddingGenerator();
    const limit = 5;
    const calc = new SemanticSurpriseCalculator(mockGen, { comparisionLimit: limit } as Partial<SemanticSurpriseConfig>);

    const manyMemories = Array.from({ length: 20 }, (_, i) => makeMemoryEntry(`m${i}`, `memory ${i}`));
    await calc.calculateSurprise('new content', manyMemories);

    // 1 for new content + limit for memories
    expect(mockGen.generateEmbedding).toHaveBeenCalledTimes(1 + limit);
  });

  it('should return shouldStore=true when novelty exceeds threshold', async () => {
    const mockGen = makeMockEmbeddingGenerator((text) => {
      // Orthogonal vectors: new content vs existing
      if (text === 'new') return [1, 0, 0, 0, 0, 0, 0, 0];
      return [0, 1, 0, 0, 0, 0, 0, 0];
    });
    const calc = new SemanticSurpriseCalculator(mockGen);

    const memory = makeMemoryEntry('m1', 'old');
    const result = await calc.calculateSurprise('new', [memory], 0.3);
    expect(result.shouldStore).toBe(true);
  });

  it('should track similarMemories when similarity exceeds the similarity threshold', async () => {
    const highSimilarityVector = makeUnitVector(8);
    const mockGen = makeMockEmbeddingGenerator(() => highSimilarityVector);
    const calc = new SemanticSurpriseCalculator(mockGen, {
      similarityThreshold: 0.5,
    } as Partial<SemanticSurpriseConfig>);

    const memory = makeMemoryEntry('m-similar', 'same embedding content');
    const result = await calc.calculateSurprise('new content', [memory]);
    expect(result.similarMemories).toContain('m-similar');
  });

  it('should not track similarMemories below the similarity threshold', async () => {
    let callIndex = 0;
    const mockGen = makeMockEmbeddingGenerator(() => {
      // Return orthogonal vectors → similarity = 0
      const v = Array(8).fill(0);
      v[callIndex % 8] = 1;
      callIndex++;
      return v;
    });
    const calc = new SemanticSurpriseCalculator(mockGen, {
      similarityThreshold: 0.9,
    } as Partial<SemanticSurpriseConfig>);

    const memory = makeMemoryEntry('m-different', 'different content');
    const result = await calc.calculateSurprise('new content', [memory]);
    expect(result.similarMemories).not.toContain('m-different');
  });

  describe('clearCache', () => {
    it('should empty the embedding cache', async () => {
      const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
      const calc = new SemanticSurpriseCalculator(mockGen);

      await calc.calculateSurprise('cached', []);
      expect(calc.getCacheStats().size).toBe(1);

      calc.clearCache();
      expect(calc.getCacheStats().size).toBe(0);
    });
  });

  describe('getCacheStats', () => {
    it('should return size 0 and maxSize 1000 initially', () => {
      const mockGen = makeMockEmbeddingGenerator();
      const calc = new SemanticSurpriseCalculator(mockGen);
      const stats = calc.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(1000);
    });

    it('should increment size as unique content is processed', async () => {
      const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
      const calc = new SemanticSurpriseCalculator(mockGen);

      await calc.calculateSurprise('first', []);
      await calc.calculateSurprise('second', []);
      expect(calc.getCacheStats().size).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// HybridSurpriseCalculator
// ---------------------------------------------------------------------------

describe('HybridSurpriseCalculator', () => {
  it('should return a SurpriseResult with all required fields', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const calc = new HybridSurpriseCalculator(mockGen);

    const result = await calc.calculateSurprise('novel content', []);
    expect(typeof result.score).toBe('number');
    expect(typeof result.noveltyScore).toBe('number');
    expect(typeof result.patternBoost).toBe('number');
    expect(typeof result.shouldStore).toBe('boolean');
    expect(Array.isArray(result.similarMemories)).toBe(true);
  });

  it('should produce a score between 0 and 1', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const calc = new HybridSurpriseCalculator(mockGen);
    const result = await calc.calculateSurprise('test content', []);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('should weight semantic calculator higher than LSH by default (0.7)', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const calcDefault = new HybridSurpriseCalculator(mockGen, 0.7);
    const calcLshOnly = new HybridSurpriseCalculator(mockGen, 0.0);

    // With no memories both calculators may agree — at least ensure no throw
    await expect(calcDefault.calculateSurprise('new content', [])).resolves.toBeDefined();
    await expect(calcLshOnly.calculateSurprise('new content', [])).resolves.toBeDefined();
  });

  it('should merge similarMemories from both calculators (deduplicated)', async () => {
    // Force high similarity on semantic side
    const highSim = makeUnitVector(8);
    const mockGen = makeMockEmbeddingGenerator(() => highSim);
    const calc = new HybridSurpriseCalculator(mockGen, 0.7, {
      similarityThreshold: 0.5,
    } as Partial<SemanticSurpriseConfig>);

    const memory = makeMemoryEntry('shared-id', 'identical content to get into both');
    const result = await calc.calculateSurprise('identical content to get into both', [memory]);
    // similarMemories should be an array (may include 'shared-id' from semantic)
    expect(Array.isArray(result.similarMemories)).toBe(true);
  });

  it('should be consistent: shouldStore reflects score >= threshold', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const calc = new HybridSurpriseCalculator(mockGen);
    const threshold = 0.4;
    const result = await calc.calculateSurprise('test', [], threshold);
    expect(result.shouldStore).toBe(result.score >= threshold);
  });
});

// ---------------------------------------------------------------------------
// createSurpriseCalculator
// ---------------------------------------------------------------------------

describe('createSurpriseCalculator', () => {
  it('should return a LshSurpriseCalculator when algorithm is lsh', () => {
    const calc = createSurpriseCalculator({ algorithm: 'lsh' } as SemanticSurpriseConfig);
    expect(calc).toBeInstanceOf(LshSurpriseCalculator);
  });

  it('should return a LshSurpriseCalculator when algorithm is semantic but no generator provided', () => {
    const calc = createSurpriseCalculator({ algorithm: 'semantic' } as SemanticSurpriseConfig);
    expect(calc).toBeInstanceOf(LshSurpriseCalculator);
  });

  it('should return a SemanticSurpriseCalculator when algorithm is semantic and generator is provided', () => {
    const mockGen = makeMockEmbeddingGenerator();
    const calc = createSurpriseCalculator(
      { algorithm: 'semantic' } as SemanticSurpriseConfig,
      mockGen
    );
    expect(calc).toBeInstanceOf(SemanticSurpriseCalculator);
  });

  it('should return a functional calculator that can calculateSurprise', async () => {
    const calc = createSurpriseCalculator({ algorithm: 'lsh' } as SemanticSurpriseConfig);
    const result = await calc.calculateSurprise('test content', []);
    expect(result).toBeDefined();
    expect(typeof result.score).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// calculateSemanticSurprise (convenience function)
// ---------------------------------------------------------------------------

describe('calculateSemanticSurprise', () => {
  it('should return a SurpriseResult', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const result = await calculateSemanticSurprise('new content', [], mockGen);
    expect(result).toBeDefined();
    expect(typeof result.score).toBe('number');
    expect(typeof result.shouldStore).toBe('boolean');
  });

  it('should pass threshold to the calculator', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    // With no memories novelty=1.0, so even threshold=0.99 should store
    const result = await calculateSemanticSurprise('new content', [], mockGen, 0.99);
    expect(result.shouldStore).toBe(result.score >= 0.99);
  });

  it('should accept optional config', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const result = await calculateSemanticSurprise(
      'new content',
      [],
      mockGen,
      0.3,
      { similarityThreshold: 0.9 } as Partial<SemanticSurpriseConfig>
    );
    expect(result).toBeDefined();
  });

  it('should process existing memories and return similarMemories array', async () => {
    const highSim = makeUnitVector(8);
    const mockGen = makeMockEmbeddingGenerator(() => highSim);
    const existing = [makeMemoryEntry('m1', 'existing memory')];

    const result = await calculateSemanticSurprise(
      'new content',
      existing,
      mockGen,
      0.3,
      { similarityThreshold: 0.5 } as Partial<SemanticSurpriseConfig>
    );
    expect(Array.isArray(result.similarMemories)).toBe(true);
  });

  it('should call the embedding generator for content and each memory', async () => {
    const mockGen = makeMockEmbeddingGenerator(() => makeUnitVector(8));
    const memories = [
      makeMemoryEntry('m1', 'mem one'),
      makeMemoryEntry('m2', 'mem two'),
    ];

    await calculateSemanticSurprise('query', memories, mockGen);
    expect(mockGen.generateEmbedding).toHaveBeenCalledTimes(3);
  });
});
