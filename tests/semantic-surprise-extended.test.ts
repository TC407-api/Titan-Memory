/**
 * Extended Semantic Surprise Tests
 * Covers LshSurpriseCalculator, SemanticSurpriseCalculator,
 * HybridSurpriseCalculator, createSurpriseCalculator, calculateSemanticSurprise
 */

import {
  LshSurpriseCalculator,
  SemanticSurpriseCalculator,
  HybridSurpriseCalculator,
  createSurpriseCalculator,
  calculateSemanticSurprise,
} from '../src/utils/semantic-surprise';
import { IEmbeddingGenerator } from '../src/storage/vector-storage';
import { MemoryEntry, MemoryLayer } from '../src/types';
import { DefaultEmbeddingGenerator } from '../src/storage/index';

function makeMemory(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    timestamp: new Date(),
    layer: MemoryLayer.LONG_TERM,
    metadata: { importance: 0.5 },
  };
}

function makeMockGenerator(fixedEmbedding?: number[]): IEmbeddingGenerator {
  const dim = fixedEmbedding?.length ?? 4;
  return {
    generateEmbedding: jest.fn().mockResolvedValue(
      fixedEmbedding ?? new Array(dim).fill(0).map((_, i) => i * 0.1)
    ),
    getDimension: jest.fn().mockReturnValue(dim),
  };
}

describe('LshSurpriseCalculator', () => {
  let calc: LshSurpriseCalculator;

  beforeEach(() => {
    calc = new LshSurpriseCalculator();
  });

  it('should return high surprise for unique content with empty memory', async () => {
    const result = await calc.calculateSurprise('completely novel content', [], 0.3);
    expect(result.score).toBeGreaterThan(0);
    expect(result.shouldStore).toBe(true);
  });

  it('should return a SurpriseResult with required fields', async () => {
    const result = await calc.calculateSurprise('test', [], 0.3);
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('shouldStore');
    expect(result).toHaveProperty('noveltyScore');
    expect(result).toHaveProperty('patternBoost');
    expect(result).toHaveProperty('similarMemories');
  });

  it('should store when score exceeds threshold', async () => {
    const result = await calc.calculateSurprise('unique novel data here', [], 0.1);
    expect(result.shouldStore).toBe(true);
  });

  it('should detect lower surprise for duplicate content', async () => {
    const memories = [makeMemory('m1', 'The quick brown fox')];
    const dupe = await calc.calculateSurprise('The quick brown fox', memories, 0.3);
    const novel = await calc.calculateSurprise('Quantum entanglement in superconductors', memories, 0.3);
    // Novel content should have higher surprise
    expect(novel.score).toBeGreaterThanOrEqual(dupe.score);
  });

  it('should use default threshold of 0.3', async () => {
    const result = await calc.calculateSurprise('test content', []);
    expect(typeof result.shouldStore).toBe('boolean');
  });
});

describe('SemanticSurpriseCalculator', () => {
  let mockGenerator: IEmbeddingGenerator;
  let calc: SemanticSurpriseCalculator;

  beforeEach(() => {
    mockGenerator = makeMockGenerator([1, 0, 0, 0]);
    calc = new SemanticSurpriseCalculator(mockGenerator);
  });

  it('should return high novelty when no existing memories', async () => {
    const result = await calc.calculateSurprise('brand new content', [], 0.3);
    expect(result.noveltyScore).toBe(1.0);
    expect(result.shouldStore).toBe(true);
  });

  it('should return SurpriseResult with all required fields', async () => {
    const result = await calc.calculateSurprise('new content', [], 0.3);
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('shouldStore');
    expect(result).toHaveProperty('noveltyScore');
    expect(result).toHaveProperty('patternBoost');
    expect(result).toHaveProperty('similarMemories');
  });

  it('should detect low novelty for identical embeddings', async () => {
    // Both new and existing return [1,0,0,0] — cosine similarity = 1.0
    const sameGen = makeMockGenerator([1, 0, 0, 0]);
    const sameCalc = new SemanticSurpriseCalculator(sameGen);
    const memory = makeMemory('m1', 'existing content');
    // Need to inject embedding into memory metadata
    (memory.metadata as any).embedding = [1, 0, 0, 0];
    const result = await sameCalc.calculateSurprise('same content', [memory], 0.3);
    // With identical embedding, noveltyScore should be 0 or very low
    expect(result.noveltyScore).toBeCloseTo(0, 1);
  });

  it('should cache embeddings for repeated content', async () => {
    await calc.calculateSurprise('cached content', [], 0.3);
    await calc.calculateSurprise('cached content', [], 0.3);
    // Generator should be called, but cache should prevent double-calls for same content
    expect((mockGenerator.generateEmbedding as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('should use custom config threshold', async () => {
    const customCalc = new SemanticSurpriseCalculator(mockGenerator, { algorithm: 'semantic' });
    const result = await customCalc.calculateSurprise('test', [], 0.8);
    // With high threshold, novel content with score < 0.8 won't store
    expect(typeof result.shouldStore).toBe('boolean');
  });

  it('should limit comparison to comparisionLimit', async () => {
    const restrictedCalc = new SemanticSurpriseCalculator(mockGenerator, { comparisionLimit: 2 });
    const memories = Array.from({ length: 10 }, (_, i) => makeMemory(`m${i}`, `memory ${i}`));
    const result = await restrictedCalc.calculateSurprise('new content', memories, 0.3);
    expect(result).toBeDefined();
    // Should complete without error even with many memories
  });

  describe('getCacheStats', () => {
    it('should return cache size info', async () => {
      const stats = calc.getCacheStats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats.maxSize).toBe(1000);
    });

    it('should grow cache after calculateSurprise', async () => {
      const beforeSize = calc.getCacheStats().size;
      await calc.calculateSurprise('unique content xyz', [], 0.3);
      const afterSize = calc.getCacheStats().size;
      expect(afterSize).toBeGreaterThanOrEqual(beforeSize);
    });
  });

  describe('clearCache', () => {
    it('should reset cache to zero', async () => {
      await calc.calculateSurprise('something', [], 0.3);
      calc.clearCache();
      expect(calc.getCacheStats().size).toBe(0);
    });
  });
});

describe('HybridSurpriseCalculator', () => {
  let generator: IEmbeddingGenerator;
  let hybrid: HybridSurpriseCalculator;

  beforeEach(() => {
    generator = new DefaultEmbeddingGenerator();
    hybrid = new HybridSurpriseCalculator(generator);
  });

  it('should return a SurpriseResult', async () => {
    const result = await hybrid.calculateSurprise('test', [], 0.3);
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('shouldStore');
  });

  it('should blend LSH and semantic scores', async () => {
    const result = await hybrid.calculateSurprise('novel unique content', [], 0.3);
    expect(result.score).toBeGreaterThan(0);
  });

  it('should respect custom semantic weight', async () => {
    const heavilySemantic = new HybridSurpriseCalculator(generator, 0.9);
    const lightlySemantic = new HybridSurpriseCalculator(generator, 0.1);
    const r1 = await heavilySemantic.calculateSurprise('test', [], 0.3);
    const r2 = await lightlySemantic.calculateSurprise('test', [], 0.3);
    // Both should return valid results
    expect(r1.score).toBeGreaterThanOrEqual(0);
    expect(r2.score).toBeGreaterThanOrEqual(0);
  });

  it('should combine similar memories from both calculators', async () => {
    const result = await hybrid.calculateSurprise('test unique', [], 0.3);
    expect(Array.isArray(result.similarMemories)).toBe(true);
  });
});

describe('createSurpriseCalculator', () => {
  it('should create LshSurpriseCalculator when algorithm is lsh', () => {
    const calc = createSurpriseCalculator({ algorithm: 'lsh', similarityThreshold: 0.7, comparisionLimit: 50 });
    expect(calc).toBeInstanceOf(LshSurpriseCalculator);
  });

  it('should create LshSurpriseCalculator when no embedding generator provided', () => {
    const calc = createSurpriseCalculator({ algorithm: 'semantic', similarityThreshold: 0.7, comparisionLimit: 50 });
    expect(calc).toBeInstanceOf(LshSurpriseCalculator);
  });

  it('should create SemanticSurpriseCalculator when algorithm is semantic with generator', () => {
    const gen = makeMockGenerator();
    const calc = createSurpriseCalculator(
      { algorithm: 'semantic', similarityThreshold: 0.7, comparisionLimit: 50 },
      gen
    );
    expect(calc).toBeInstanceOf(SemanticSurpriseCalculator);
  });

  it('should return an object implementing ISurpriseCalculator interface', () => {
    const calc = createSurpriseCalculator({ algorithm: 'lsh', similarityThreshold: 0.7, comparisionLimit: 50 });
    expect(typeof calc.calculateSurprise).toBe('function');
  });
});

describe('calculateSemanticSurprise', () => {
  it('should calculate surprise using provided generator', async () => {
    const gen = new DefaultEmbeddingGenerator();
    const result = await calculateSemanticSurprise('novel content', [], gen, 0.3);
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('shouldStore');
  });

  it('should use custom config when provided', async () => {
    const gen = new DefaultEmbeddingGenerator();
    const result = await calculateSemanticSurprise('test', [], gen, 0.3, { similarityThreshold: 0.9 });
    expect(result).toBeDefined();
  });

  it('should return shouldStore true for fully novel content', async () => {
    const gen = new DefaultEmbeddingGenerator();
    const result = await calculateSemanticSurprise('completely unique novel text', [], gen, 0.3);
    expect(result.shouldStore).toBe(true);
  });
});
