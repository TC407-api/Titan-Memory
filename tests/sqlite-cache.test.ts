/**
 * Tests for SqliteCacheLayer
 * Covers write-through, cache hit/miss, degraded mode, LRU eviction,
 * get/delete sync, and close cleanup.
 */

import { SqliteCacheLayer } from '../src/storage/sqlite-cache';
import { IVectorStorage, VectorSearchResult } from '../src/storage/vector-storage';
import { MemoryEntry, MemoryLayer } from '../src/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    layer: MemoryLayer.FACTUAL,
    timestamp: new Date(),
    metadata: { source: 'test', tags: ['unit'] },
  };
}

function makeSearchResult(id: string, content: string, score = 0.9): VectorSearchResult {
  return { id, content, score, metadata: { source: 'test' } };
}

function makeMockStorage(): jest.Mocked<IVectorStorage> {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    isHybridSearchEnabled: jest.fn().mockReturnValue(true),
    get: jest.fn().mockResolvedValue(null),
    getRecent: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(true),
    count: jest.fn().mockResolvedValue(0),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

let tmpDir: string;
let dbPath: string;
let activeCache: SqliteCacheLayer | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-cache-'));
  dbPath = path.join(tmpDir, 'cache.db');
  activeCache = null;
});

afterEach(async () => {
  // Close SQLite before deleting temp dir (Windows EPERM fix)
  if (activeCache) {
    try { await activeCache.close(); } catch { /* already closed */ }
    activeCache = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper to track cache for cleanup
function trackCache(cache: SqliteCacheLayer): SqliteCacheLayer {
  activeCache = cache;
  return cache;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SqliteCacheLayer', () => {
  test('initialize delegates to inner storage', async () => {
    const inner = makeMockStorage();
    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();
    expect(inner.initialize).toHaveBeenCalledTimes(1);
  });

  test('insert writes to both cache and inner (write-through)', async () => {
    const inner = makeMockStorage();
    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    const entry = makeEntry('m1', 'hello world');
    await cache.insert(entry);

    // Inner was called
    expect(inner.insert).toHaveBeenCalledWith(entry);

    // Cache has it — get should return from cache without calling inner
    const result = await cache.get('m1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('m1');
    expect(result!.content).toBe('hello world');
    // inner.get should NOT have been called since cache hit
    expect(inner.get).not.toHaveBeenCalled();
  });

  test('cache hit returns memory without calling upstream', async () => {
    const inner = makeMockStorage();
    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    // Pre-populate cache via insert
    await cache.insert(makeEntry('m2', 'cached value'));

    // Reset mock to verify no further calls
    inner.get.mockClear();

    const result = await cache.get('m2');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('cached value');
    expect(inner.get).not.toHaveBeenCalled();
  });

  test('cache miss falls through to upstream', async () => {
    const inner = makeMockStorage();
    inner.get.mockResolvedValue(makeSearchResult('m3', 'from upstream'));

    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    const result = await cache.get('m3');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('from upstream');
    expect(inner.get).toHaveBeenCalledWith('m3');
  });

  test('upstream failure on insert serves from cache (degraded mode)', async () => {
    const inner = makeMockStorage();
    inner.insert.mockRejectedValue(new Error('Zilliz down'));

    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    const entry = makeEntry('m4', 'resilient data');
    // Should not throw — degrades gracefully
    await cache.insert(entry);

    // Data is still in cache
    const result = await cache.get('m4');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('resilient data');
  });

  test('cache respects maxSize and evicts LRU', async () => {
    const inner = makeMockStorage();
    const cache = trackCache(new SqliteCacheLayer(inner, dbPath, 3));
    await cache.initialize();

    // Use explicit last_accessed ordering via sequential inserts with time gaps
    // We mock Date.now to control ordering
    let fakeTime = 1000;
    const origDateNow = Date.now;
    Date.now = jest.fn(() => fakeTime);

    try {
      // Insert 3 entries with increasing timestamps
      fakeTime = 1000;
      await cache.insert(makeEntry('a', 'first'));
      fakeTime = 2000;
      await cache.insert(makeEntry('b', 'second'));
      fakeTime = 3000;
      await cache.insert(makeEntry('c', 'third'));

      // Access 'a' to make it recently used (higher timestamp)
      fakeTime = 4000;
      await cache.get('a');

      // Insert 4th — should evict 'b' (last_accessed=2000, the lowest)
      fakeTime = 5000;
      await cache.insert(makeEntry('d', 'fourth'));

      // 'b' should be evicted from cache, falls through to inner
      inner.get.mockResolvedValue(null);
      fakeTime = 6000;
      const evicted = await cache.get('b');
      expect(inner.get).toHaveBeenCalledWith('b');
      expect(evicted).toBeNull();

      // 'a' should still be in cache
      inner.get.mockClear();
      fakeTime = 7000;
      const kept = await cache.get('a');
      expect(kept).not.toBeNull();
      expect(kept!.content).toBe('first');
      expect(inner.get).not.toHaveBeenCalled();
    } finally {
      Date.now = origDateNow;
    }
  });

  test('delete removes from both cache and inner', async () => {
    const inner = makeMockStorage();
    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    await cache.insert(makeEntry('m5', 'to delete'));

    const deleted = await cache.delete('m5');
    expect(deleted).toBe(true);
    expect(inner.delete).toHaveBeenCalledWith('m5');

    // Cache should no longer have it
    inner.get.mockResolvedValue(null);
    const result = await cache.get('m5');
    expect(result).toBeNull();
  });

  test('search delegates to inner (no local vector search)', async () => {
    const inner = makeMockStorage();
    inner.search.mockResolvedValue([makeSearchResult('s1', 'search result')]);

    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    const results = await cache.search('query', 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('s1');
    expect(inner.search).toHaveBeenCalledWith('query', 5);
  });

  test('hybridSearch delegates to inner', async () => {
    const inner = makeMockStorage();
    (inner.hybridSearch as jest.Mock).mockResolvedValue([makeSearchResult('h1', 'hybrid result')]);

    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    const results = await cache.hybridSearch!('query', 5);
    expect(results).toHaveLength(1);
    expect(inner.hybridSearch).toHaveBeenCalledWith('query', 5, undefined);
  });

  test('getRecent delegates to inner', async () => {
    const inner = makeMockStorage();
    inner.getRecent.mockResolvedValue([makeSearchResult('r1', 'recent')]);

    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    const results = await cache.getRecent(10);
    expect(results).toHaveLength(1);
    expect(inner.getRecent).toHaveBeenCalledWith(10);
  });

  test('count delegates to inner', async () => {
    const inner = makeMockStorage();
    inner.count.mockResolvedValue(42);

    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    const result = await cache.count();
    expect(result).toBe(42);
  });

  test('close cleans up SQLite and inner', async () => {
    const inner = makeMockStorage();
    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    await cache.close();
    activeCache = null; // Already closed
    expect(inner.close).toHaveBeenCalledTimes(1);

    // Subsequent get should not crash (graceful after close)
    inner.get.mockResolvedValue(makeSearchResult('x', 'post-close'));
    const result = await cache.get('x');
    // Falls through to inner since db is closed
    expect(result).not.toBeNull();
  });

  test('isHybridSearchEnabled delegates to inner', async () => {
    const inner = makeMockStorage();
    (inner.isHybridSearchEnabled as jest.Mock).mockReturnValue(true);

    const cache = new SqliteCacheLayer(inner, dbPath);
    // No need to initialize for this check
    expect(cache.isHybridSearchEnabled!()).toBe(true);
  });

  test('cache miss from upstream backfills cache', async () => {
    const inner = makeMockStorage();
    inner.get.mockResolvedValue(makeSearchResult('m6', 'backfill me'));

    const cache = trackCache(new SqliteCacheLayer(inner, dbPath));
    await cache.initialize();

    // First call — miss, goes to inner
    await cache.get('m6');
    expect(inner.get).toHaveBeenCalledTimes(1);

    // Second call — should be in cache now
    inner.get.mockClear();
    const result = await cache.get('m6');
    expect(result!.content).toBe('backfill me');
    expect(inner.get).not.toHaveBeenCalled();
  });
});
