/**
 * Tests for CachedEmbeddingGenerator
 * Covers LRU cache hits, misses, eviction, TTL expiry, batch operations,
 * stats tracking, and delegation to the underlying generator.
 */

import { CachedEmbeddingGenerator, CacheConfig } from '../src/storage/embeddings/cached-embedding';
import { IEmbeddingGenerator } from '../src/storage/vector-storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmbedding(seed: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, i) => seed + i * 0.1);
}

/**
 * Creates a mock IEmbeddingGenerator whose generateEmbedding resolves with a
 * deterministic vector derived from the input text.
 */
function makeMockGenerator(dim = 4): jest.Mocked<IEmbeddingGenerator> & {
  generateBatchEmbeddings: jest.Mock;
} {
  let callIndex = 0;

  const mock = {
    getDimension: jest.fn(() => dim),
    generateEmbedding: jest.fn(async (_text: string) => {
      callIndex += 1;
      return makeEmbedding(callIndex, dim);
    }),
    generateBatchEmbeddings: jest.fn(async (texts: string[]) => {
      return texts.map((_t, i) => {
        callIndex += 1;
        return makeEmbedding(callIndex + i, dim);
      });
    }),
  };

  return mock as unknown as jest.Mocked<IEmbeddingGenerator> & {
    generateBatchEmbeddings: jest.Mock;
  };
}

/** Sleep helper to advance time for TTL tests */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CachedEmbeddingGenerator — constructor / configuration
// ---------------------------------------------------------------------------

describe('CachedEmbeddingGenerator', () => {
  describe('constructor', () => {
    it('should accept a generator with no config and apply defaults', () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);
      const stats = cached.getStats();

      expect(stats.maxSize).toBe(10000);
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('should accept a partial config and merge with defaults', () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { maxSize: 500 });

      expect(cached.getStats().maxSize).toBe(500);
    });

    it('should accept a full config object', () => {
      const gen = makeMockGenerator();
      const config: Partial<CacheConfig> = { maxSize: 200, ttlMs: 5000 };
      const cached = new CachedEmbeddingGenerator(gen, config);

      expect(cached.getStats().maxSize).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // getDimension / getUnderlyingGenerator
  // ---------------------------------------------------------------------------

  describe('getDimension', () => {
    it('should delegate to the underlying generator', () => {
      const gen = makeMockGenerator(768);
      const cached = new CachedEmbeddingGenerator(gen);

      expect(cached.getDimension()).toBe(768);
      expect(gen.getDimension).toHaveBeenCalledTimes(1);
    });
  });

  describe('getUnderlyingGenerator', () => {
    it('should return the original generator instance', () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      expect(cached.getUnderlyingGenerator()).toBe(gen);
    });
  });

  // ---------------------------------------------------------------------------
  // generateEmbedding — happy path
  // ---------------------------------------------------------------------------

  describe('generateEmbedding', () => {
    it('should call the underlying generator on first request (cache miss)', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      const result = await cached.generateEmbedding('hello world');

      expect(gen.generateEmbedding).toHaveBeenCalledTimes(1);
      expect(gen.generateEmbedding).toHaveBeenCalledWith('hello world');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(4);
    });

    it('should return cached embedding on second request (cache hit)', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      const first = await cached.generateEmbedding('repeat text');
      const second = await cached.generateEmbedding('repeat text');

      // Generator called only once despite two requests
      expect(gen.generateEmbedding).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('should call the generator separately for distinct texts', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('text A');
      await cached.generateEmbedding('text B');

      expect(gen.generateEmbedding).toHaveBeenCalledTimes(2);
    });

    it('should handle empty string input', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      const result = await cached.generateEmbedding('');

      expect(result.length).toBe(4);
      expect(gen.generateEmbedding).toHaveBeenCalledWith('');
    });

    it('should handle very long text input', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);
      const longText = 'a'.repeat(10000);

      const result = await cached.generateEmbedding(longText);

      expect(result.length).toBe(4);
    });

    it('should handle unicode text', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      const result = await cached.generateEmbedding('你好 αβγ 🚀');

      expect(result.length).toBe(4);
      expect(gen.generateEmbedding).toHaveBeenCalledTimes(1);
    });

    it('should treat two distinct texts as separate cache keys even with same length', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      // Both strings have length 3 — cache key includes both hash and length,
      // so hash collision would be needed to confuse them.  This checks the
      // obvious case where same-length different-content texts are distinct.
      await cached.generateEmbedding('abc');
      await cached.generateEmbedding('xyz');

      expect(gen.generateEmbedding).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // generateEmbedding — stats tracking
  // ---------------------------------------------------------------------------

  describe('stats tracking via generateEmbedding', () => {
    it('should increment misses on cache miss', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('new text');

      expect(cached.getStats().misses).toBe(1);
      expect(cached.getStats().hits).toBe(0);
    });

    it('should increment hits on cache hit', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('cached text');
      await cached.generateEmbedding('cached text');
      await cached.generateEmbedding('cached text');

      expect(cached.getStats().hits).toBe(2);
      expect(cached.getStats().misses).toBe(1);
    });

    it('should compute hitRate as hits / (hits + misses)', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      // 1 miss then 3 hits → hitRate = 3/4 = 0.75
      await cached.generateEmbedding('text');
      await cached.generateEmbedding('text');
      await cached.generateEmbedding('text');
      await cached.generateEmbedding('text');

      const stats = cached.getStats();
      expect(stats.hitRate).toBeCloseTo(0.75);
    });

    it('should report hitRate as 0 when no requests made', () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      expect(cached.getStats().hitRate).toBe(0);
    });

    it('should reflect cache size growing with unique texts', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('alpha');
      await cached.generateEmbedding('beta');
      await cached.generateEmbedding('gamma');

      expect(cached.getStats().size).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // isCached
  // ---------------------------------------------------------------------------

  describe('isCached', () => {
    it('should return false before any embedding is generated', () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      expect(cached.isCached('never seen')).toBe(false);
    });

    it('should return true after an embedding is generated for the text', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('warm me up');

      expect(cached.isCached('warm me up')).toBe(true);
    });

    it('should return false for a different text even if similar', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('text A');

      expect(cached.isCached('text B')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // LRU eviction
  // ---------------------------------------------------------------------------

  describe('LRU eviction', () => {
    it('should evict the oldest entry when maxSize is exceeded', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { maxSize: 3 });

      await cached.generateEmbedding('entry-1');
      await cached.generateEmbedding('entry-2');
      await cached.generateEmbedding('entry-3');

      // Cache is full at this point
      expect(cached.getStats().size).toBe(3);

      // Adding a 4th entry evicts entry-1 (oldest, least recently used)
      await cached.generateEmbedding('entry-4');

      expect(cached.getStats().size).toBe(3);
      expect(cached.isCached('entry-1')).toBe(false);
      expect(cached.isCached('entry-4')).toBe(true);
    });

    it('should not evict a recently accessed entry (LRU refresh)', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { maxSize: 3 });

      await cached.generateEmbedding('entry-1');
      await cached.generateEmbedding('entry-2');
      await cached.generateEmbedding('entry-3');

      // Access entry-1 to move it to most-recently-used position
      await cached.generateEmbedding('entry-1');

      // Adding entry-4 should evict entry-2 (now the oldest)
      await cached.generateEmbedding('entry-4');

      expect(cached.isCached('entry-1')).toBe(true);
      expect(cached.isCached('entry-2')).toBe(false);
    });

    it('should keep cache size at exactly maxSize after multiple evictions', async () => {
      const gen = makeMockGenerator();
      const maxSize = 5;
      const cached = new CachedEmbeddingGenerator(gen, { maxSize });

      for (let i = 0; i < 20; i++) {
        await cached.generateEmbedding(`entry-${i}`);
      }

      expect(cached.getStats().size).toBe(maxSize);
    });

    it('should call the generator again after an entry is evicted', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { maxSize: 2 });

      await cached.generateEmbedding('alpha');  // miss #1
      await cached.generateEmbedding('beta');   // miss #2 — cache full
      await cached.generateEmbedding('gamma');  // miss #3 — evicts 'alpha'

      expect(gen.generateEmbedding).toHaveBeenCalledTimes(3);

      // 'alpha' was evicted; requesting it again is a miss
      await cached.generateEmbedding('alpha');

      expect(gen.generateEmbedding).toHaveBeenCalledTimes(4);
    });
  });

  // ---------------------------------------------------------------------------
  // TTL expiry
  // ---------------------------------------------------------------------------

  describe('TTL expiry', () => {
    it('should return cached value before TTL expires', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { ttlMs: 500 });

      await cached.generateEmbedding('fresh');
      const result = await cached.generateEmbedding('fresh');

      expect(gen.generateEmbedding).toHaveBeenCalledTimes(1);
      expect(result.length).toBe(4);
    });

    it('should treat an expired entry as a cache miss', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { ttlMs: 50 });

      await cached.generateEmbedding('expiring');
      expect(gen.generateEmbedding).toHaveBeenCalledTimes(1);

      // Wait for TTL to pass
      await sleep(80);

      await cached.generateEmbedding('expiring');
      expect(gen.generateEmbedding).toHaveBeenCalledTimes(2);
    });

    it('should return false from isCached after TTL expires', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { ttlMs: 50 });

      await cached.generateEmbedding('short-lived');
      expect(cached.isCached('short-lived')).toBe(true);

      await sleep(80);

      expect(cached.isCached('short-lived')).toBe(false);
    });

    it('should exclude expired entries from cache size when accessed', async () => {
      // Note: the LRUCache lazily evicts on access; size() reflects stored
      // entries including expired ones until they are accessed.  This test
      // confirms that isCached correctly returns false post-TTL even though the
      // underlying Map may still have the entry until accessed.
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { maxSize: 10, ttlMs: 50 });

      await cached.generateEmbedding('ttl-text');
      await sleep(80);

      // Accessing the expired entry removes it from the cache
      expect(cached.isCached('ttl-text')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // clearCache
  // ---------------------------------------------------------------------------

  describe('clearCache', () => {
    it('should empty the cache', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('a');
      await cached.generateEmbedding('b');
      cached.clearCache();

      expect(cached.getStats().size).toBe(0);
    });

    it('should reset hits and misses to zero', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('x');
      await cached.generateEmbedding('x');
      cached.clearCache();

      const stats = cached.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('should cause previously cached texts to be regenerated', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('text');
      cached.clearCache();
      await cached.generateEmbedding('text');

      expect(gen.generateEmbedding).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // generateBatchEmbeddings
  // ---------------------------------------------------------------------------

  describe('generateBatchEmbeddings', () => {
    it('should return an array with the same length as the input', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      const results = await cached.generateBatchEmbeddings(['a', 'b', 'c']);

      expect(results.length).toBe(3);
    });

    it('should call generateBatchEmbeddings on the underlying generator when available', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateBatchEmbeddings(['x', 'y', 'z']);

      expect(gen.generateBatchEmbeddings).toHaveBeenCalledTimes(1);
      expect(gen.generateBatchEmbeddings).toHaveBeenCalledWith(['x', 'y', 'z']);
    });

    it('should fall back to sequential generateEmbedding when batch method absent', async () => {
      // Build a generator that has NO generateBatchEmbeddings method
      const gen: IEmbeddingGenerator = {
        getDimension: jest.fn(() => 4),
        generateEmbedding: jest.fn(async (_text: string) => makeEmbedding(1)),
      };
      const cached = new CachedEmbeddingGenerator(gen);

      const results = await cached.generateBatchEmbeddings(['p', 'q']);

      expect(gen.generateEmbedding).toHaveBeenCalledTimes(2);
      expect(results.length).toBe(2);
    });

    it('should serve cached texts from cache and only batch-fetch uncached ones', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      // Pre-warm 'a' and 'c'
      await cached.generateEmbedding('a');
      await cached.generateEmbedding('c');
      gen.generateBatchEmbeddings.mockClear();
      gen.generateEmbedding.mockClear();

      // Batch request where 'a' and 'c' are cached, 'b' is not
      const results = await cached.generateBatchEmbeddings(['a', 'b', 'c']);

      expect(results.length).toBe(3);
      // Only 'b' should be forwarded to the underlying generator
      expect(gen.generateBatchEmbeddings).toHaveBeenCalledWith(['b']);
    });

    it('should serve all results from cache when every text is already cached', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateBatchEmbeddings(['one', 'two', 'three']);
      gen.generateBatchEmbeddings.mockClear();

      const results = await cached.generateBatchEmbeddings(['one', 'two', 'three']);

      expect(results.length).toBe(3);
      expect(gen.generateBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('should store batch results in the cache for subsequent single requests', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateBatchEmbeddings(['m', 'n']);
      gen.generateEmbedding.mockClear();
      gen.generateBatchEmbeddings.mockClear();

      // Individual requests should now be cache hits
      await cached.generateEmbedding('m');
      await cached.generateEmbedding('n');

      expect(gen.generateEmbedding).not.toHaveBeenCalled();
      expect(gen.generateBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('should count batch misses correctly in stats', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateBatchEmbeddings(['u', 'v', 'w']);

      expect(cached.getStats().misses).toBe(3);
      expect(cached.getStats().hits).toBe(0);
    });

    it('should count batch hits correctly in stats', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateBatchEmbeddings(['r', 's']);
      // Second call — both from cache
      await cached.generateBatchEmbeddings(['r', 's']);

      expect(cached.getStats().hits).toBe(2);
      expect(cached.getStats().misses).toBe(2);
    });

    it('should handle an empty array input', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      const results = await cached.generateBatchEmbeddings([]);

      expect(results).toEqual([]);
      expect(gen.generateBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('should preserve the original order of results', async () => {
      const gen = makeMockGenerator();
      // Override to return identifiable vectors per text
      gen.generateBatchEmbeddings.mockImplementation(async (texts: string[]) => {
        return texts.map((t, _i) => [t.charCodeAt(0), 0, 0, 0]);
      });
      const cached = new CachedEmbeddingGenerator(gen);

      // Pre-warm 'a' (charCode 97) and 'c' (charCode 99)
      gen.generateEmbedding.mockImplementation(async (text: string) => [text.charCodeAt(0), 0, 0, 0]);
      await cached.generateEmbedding('a');
      await cached.generateEmbedding('c');

      // Batch with 'b' in the middle (charCode 98)
      const results = await cached.generateBatchEmbeddings(['a', 'b', 'c']);

      expect(results[0][0]).toBe(97); // 'a'
      expect(results[1][0]).toBe(98); // 'b'
      expect(results[2][0]).toBe(99); // 'c'
    });

    it('should handle a single-element array', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      const results = await cached.generateBatchEmbeddings(['solo']);

      expect(results.length).toBe(1);
      expect(Array.isArray(results[0])).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // preload
  // ---------------------------------------------------------------------------

  describe('preload', () => {
    it('should warm the cache for all provided texts', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.preload(['pre-1', 'pre-2', 'pre-3']);

      expect(cached.isCached('pre-1')).toBe(true);
      expect(cached.isCached('pre-2')).toBe(true);
      expect(cached.isCached('pre-3')).toBe(true);
    });

    it('should cause subsequent single requests to be cache hits', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.preload(['hot-1', 'hot-2']);
      gen.generateEmbedding.mockClear();
      gen.generateBatchEmbeddings.mockClear();

      await cached.generateEmbedding('hot-1');
      await cached.generateEmbedding('hot-2');

      expect(gen.generateEmbedding).not.toHaveBeenCalled();
      expect(gen.generateBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('should handle an empty preload list without error', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await expect(cached.preload([])).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('should reflect maxSize from config', () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { maxSize: 42 });

      expect(cached.getStats().maxSize).toBe(42);
    });

    it('should report size zero initially', () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      expect(cached.getStats().size).toBe(0);
    });

    it('should update size as entries are added', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('first');
      expect(cached.getStats().size).toBe(1);

      await cached.generateEmbedding('second');
      expect(cached.getStats().size).toBe(2);
    });

    it('should not double-count the same entry when re-requested', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('same');
      await cached.generateEmbedding('same');
      await cached.generateEmbedding('same');

      expect(cached.getStats().size).toBe(1);
    });

    it('should have hitRate between 0 and 1 inclusive', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      await cached.generateEmbedding('a');
      await cached.generateEmbedding('a');

      const { hitRate } = cached.getStats();
      expect(hitRate).toBeGreaterThanOrEqual(0);
      expect(hitRate).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration — realistic usage sequence
  // ---------------------------------------------------------------------------

  describe('integration', () => {
    it('should handle a real-world pattern: preload, query, evict, regenerate', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen, { maxSize: 3 });

      // Preload 3 texts — fills cache exactly
      await cached.preload(['doc-1', 'doc-2', 'doc-3']);
      const preloadCalls = (gen.generateBatchEmbeddings as jest.Mock).mock.calls.length;
      expect(preloadCalls).toBeGreaterThan(0);

      // All three are now warm
      expect(cached.isCached('doc-1')).toBe(true);
      expect(cached.isCached('doc-2')).toBe(true);
      expect(cached.isCached('doc-3')).toBe(true);

      gen.generateBatchEmbeddings.mockClear();
      gen.generateEmbedding.mockClear();

      // Query hits cause no new generator calls
      await cached.generateEmbedding('doc-1');
      await cached.generateEmbedding('doc-3');
      expect(gen.generateEmbedding).not.toHaveBeenCalled();

      // doc-2 is now the LRU because doc-1 and doc-3 were accessed;
      // adding doc-4 should evict doc-2
      await cached.generateEmbedding('doc-4');
      expect(cached.isCached('doc-2')).toBe(false);
      expect(cached.isCached('doc-4')).toBe(true);

      // Requesting doc-2 now triggers a miss and regenerates
      await cached.generateEmbedding('doc-2');
      expect(gen.generateEmbedding).toHaveBeenCalledTimes(2); // doc-4 and doc-2
    });

    it('should track hitRate accurately across a mixed workload', async () => {
      const gen = makeMockGenerator();
      const cached = new CachedEmbeddingGenerator(gen);

      // 5 misses
      for (let i = 0; i < 5; i++) {
        await cached.generateEmbedding(`unique-${i}`);
      }

      // 5 hits (same texts)
      for (let i = 0; i < 5; i++) {
        await cached.generateEmbedding(`unique-${i}`);
      }

      const stats = cached.getStats();
      expect(stats.misses).toBe(5);
      expect(stats.hits).toBe(5);
      expect(stats.hitRate).toBeCloseTo(0.5);
    });
  });
});
