/**
 * ZillizClient Critical Path Tests
 * Mocks all HTTP calls — never hits the real Zilliz Cloud API.
 *
 * Coverage targets:
 *   - insert: happy path, failed insert (non-zero code), network error
 *   - search: results mapping, empty results, score fallback fields
 *   - hybridSearch: RRF strategy, weighted strategy, disabled fallback, filter passthrough
 *   - get: found, not found, timestamp promotion into metadata
 *   - getRecent: results mapping, timestamp promotion
 *   - delete: valid UUID, invalid UUID rejected, HTTP error
 *   - count: normal, missing collection field
 *   - initialize: collection exists, collection missing (creates it), network error (offline mode)
 *   - close: resets state
 */

import { ZillizClient, DefaultEmbeddingGenerator } from '../src/storage/zilliz-client';
import { VectorStorageConfig, HybridSearchOptions } from '../src/storage/vector-storage';
import { MemoryEntry, MemoryLayer } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: VectorStorageConfig = {
  uri: 'https://mock-zilliz.example.com',
  token: 'test-token',
  collection: 'test-memories',
};

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    content: 'test memory content',
    layer: MemoryLayer.FACTUAL,
    timestamp: new Date('2026-03-20T12:00:00.000Z'),
    metadata: { tags: ['test'] },
    ...overrides,
  };
}

/** Build a minimal fetch Response-like object */
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup: replace global fetch before each test
// ---------------------------------------------------------------------------

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  jest.resetAllMocks();
});

// ---------------------------------------------------------------------------
// DefaultEmbeddingGenerator (smoke tests — full coverage in storage.test.ts)
// ---------------------------------------------------------------------------

describe('DefaultEmbeddingGenerator', () => {
  it('should produce embeddings of the configured dimension', async () => {
    const gen = new DefaultEmbeddingGenerator(512);
    const result = await gen.generateEmbedding('hello world');
    expect(result).toHaveLength(512);
    expect(gen.getDimension()).toBe(512);
  });

  it('should produce deterministic output for identical input', async () => {
    const gen = new DefaultEmbeddingGenerator();
    const a = await gen.generateEmbedding('same');
    const b = await gen.generateEmbedding('same');
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — initialize()
// ---------------------------------------------------------------------------

describe('ZillizClient.initialize()', () => {
  it('should mark as initialized when collection already exists (code 0)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    await client.initialize();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/collections/describe');
  });

  it('should create collection when describe returns non-zero code', async () => {
    // describe → collection missing
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 100 }));
    // createRegularCollection: create + index + load
    fetchMock.mockResolvedValue(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    await client.initialize();

    // At minimum: describe + create + index + load = 4 calls
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('should not re-initialize on repeated calls', async () => {
    fetchMock.mockResolvedValue(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    await client.initialize();
    await client.initialize();

    // Second call must not fire any new fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should fall back to offline mode when network throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const client = new ZillizClient(BASE_CONFIG);
    // Should resolve without throwing
    await expect(client.initialize()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — insert()
// ---------------------------------------------------------------------------

describe('ZillizClient.insert()', () => {
  it('should POST to entities/insert with correct payload', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    await client.insert(makeEntry());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/entities/insert');

    const body = JSON.parse(init.body as string);
    expect(body.collectionName).toBe('test-memories');
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(body.data[0].content).toBe('test memory content');
    expect(Array.isArray(body.data[0].embedding)).toBe(true);
  });

  it('should serialize metadata as JSON string in the payload', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    const entry = makeEntry({ metadata: { tags: ['a', 'b'], projectId: 'proj-1' } });
    await client.insert(entry);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const meta = JSON.parse(body.data[0].metadata);
    expect(meta.tags).toEqual(['a', 'b']);
    expect(meta.projectId).toBe('proj-1');
  });

  it('should not throw when Zilliz returns a non-zero insert code', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 1, message: 'insert failed' }));

    const client = new ZillizClient(BASE_CONFIG);
    // Non-zero code triggers a console.warn — should not reject
    await expect(client.insert(makeEntry())).resolves.not.toThrow();
  });

  it('should send Authorization header with Bearer token', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    await client.insert(makeEntry());

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — search()
// ---------------------------------------------------------------------------

describe('ZillizClient.search()', () => {
  it('should return mapped VectorSearchResults from data array', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [
        { id: 'id-1', content: 'result one', distance: 0.92, metadata: '{"tags":["x"]}', timestamp: '2026-01-01T00:00:00.000Z' },
        { id: 'id-2', content: 'result two', distance: 0.87, metadata: '{}', timestamp: '2026-01-02T00:00:00.000Z' },
      ],
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const results = await client.search('test query', 5);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('id-1');
    expect(results[0].content).toBe('result one');
    expect(results[0].score).toBe(0.92);
    expect(results[0].metadata.tags).toEqual(['x']);
  });

  it('should fall back to results array when data is absent', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      results: [
        { id: 'id-3', content: 'from results', score: 0.75, metadata: '{}', timestamp: '2026-01-03T00:00:00.000Z' },
      ],
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const results = await client.search('query', 5);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('id-3');
    expect(results[0].score).toBe(0.75);
  });

  it('should return empty array when both data and results are absent', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    const results = await client.search('nothing', 5);

    expect(results).toEqual([]);
  });

  it('should promote top-level timestamp into metadata when not already set', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [
        { id: 'id-ts', content: 'timestamped', distance: 0.9, metadata: '{}', timestamp: '2026-03-20T12:00:00.000Z' },
      ],
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const [result] = await client.search('ts query', 1);

    expect(result.metadata.timestamp).toBe('2026-03-20T12:00:00.000Z');
  });

  it('should not overwrite existing timestamp in metadata', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [
        {
          id: 'id-ts2',
          content: 'already has ts',
          distance: 0.9,
          metadata: '{"timestamp":"2025-01-01T00:00:00.000Z"}',
          timestamp: '2026-03-20T12:00:00.000Z',
        },
      ],
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const [result] = await client.search('ts', 1);

    // metadata.timestamp should be the one from the metadata blob, not the top-level
    expect(result.metadata.timestamp).toBe('2025-01-01T00:00:00.000Z');
  });

  it('should use score field if distance is absent', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [{ id: 'id-score', content: 'scored', score: 0.55, metadata: '{}', timestamp: '' }],
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const [result] = await client.search('q', 1);
    expect(result.score).toBe(0.55);
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — hybridSearch()
// ---------------------------------------------------------------------------

describe('ZillizClient.hybridSearch()', () => {
  it('should fall back to regular search when hybrid is disabled', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [{ id: 'fb-1', content: 'fallback', distance: 0.8, metadata: '{}', timestamp: '' }],
    }));

    // enableHybridSearch is false by default
    const client = new ZillizClient(BASE_CONFIG);
    const results = await client.hybridSearch('query', 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    // Should call the regular search endpoint, not hybrid
    expect(url).toContain('/entities/search');
    expect(results[0].id).toBe('fb-1');
  });

  it('should POST to hybrid_search endpoint when enabled with RRF strategy', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [{ id: 'h-1', content: 'hybrid result', distance: 0.95, metadata: '{}', timestamp: '' }],
    }));

    const client = new ZillizClient({ ...BASE_CONFIG, enableHybridSearch: true });
    const opts: HybridSearchOptions = { rerankStrategy: 'rrf', rrfK: 80 };
    const results = await client.hybridSearch('search term', 5, opts);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/entities/hybrid_search');
    const body = JSON.parse(init.body as string);
    expect(body.rerank.strategy).toBe('rrf');
    expect(body.rerank.params.k).toBe(80);
    expect(results[0].id).toBe('h-1');
  });

  it('should send weighted rerank params when strategy is weighted', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0, data: [] }));

    const client = new ZillizClient({ ...BASE_CONFIG, enableHybridSearch: true });
    const opts: HybridSearchOptions = {
      rerankStrategy: 'weighted',
      denseWeight: 0.7,
      sparseWeight: 0.3,
    };
    await client.hybridSearch('weights', 5, opts);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.rerank.strategy).toBe('weighted');
    expect(body.rerank.params.weights).toEqual([0.7, 0.3]);
  });

  it('should apply optional filter when provided', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0, data: [] }));

    const client = new ZillizClient({ ...BASE_CONFIG, enableHybridSearch: true });
    const opts: HybridSearchOptions = {
      rerankStrategy: 'rrf',
      filter: 'layer == 2',
    };
    await client.hybridSearch('filtered', 3, opts);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.filter).toBe('layer == 2');
  });

  it('should request triple the limit as candidates for reranking', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0, data: [] }));

    const client = new ZillizClient({ ...BASE_CONFIG, enableHybridSearch: true });
    await client.hybridSearch('q', 4);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Each sub-search should request limit * 3 = 12 candidates
    expect(body.search[0].limit).toBe(12);
    expect(body.search[1].limit).toBe(12);
    // Top-level limit is the original value
    expect(body.limit).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — get()
// ---------------------------------------------------------------------------

describe('ZillizClient.get()', () => {
  it('should return a VectorSearchResult with score 1.0 when found', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [{ id: 'found-id', content: 'found content', metadata: '{"source":"test"}', timestamp: '2026-01-01T00:00:00.000Z' }],
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const result = await client.get('found-id');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('found-id');
    expect(result!.content).toBe('found content');
    expect(result!.score).toBe(1.0);
    expect(result!.metadata.source).toBe('test');
  });

  it('should return null when entity is not found', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0, data: [] }));

    const client = new ZillizClient(BASE_CONFIG);
    const result = await client.get('missing-id');

    expect(result).toBeNull();
  });

  it('should promote top-level timestamp into metadata on get', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [{ id: 'ts-id', content: 'with ts', metadata: '{}', timestamp: '2026-03-20T00:00:00.000Z' }],
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const result = await client.get('ts-id');

    expect(result!.metadata.timestamp).toBe('2026-03-20T00:00:00.000Z');
  });

  it('should POST the id array under the key Zilliz actually requires', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0, data: [] }));

    const client = new ZillizClient(BASE_CONFIG);
    await client.get('abc-123');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // This assertion previously required `ids`, which mirrored the implementation rather
    // than the API. Verified against live Zilliz: `ids` is rejected with code 1802
    // ("Field validation for 'ID' failed on the 'required' tag"), `id` returns code 0.
    expect(body.id).toEqual(['abc-123']);
    expect(body.ids).toBeUndefined();
    expect(body.collectionName).toBe('test-memories');
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — getRecent()
// ---------------------------------------------------------------------------

describe('ZillizClient.getRecent()', () => {
  it('should return mapped results from query endpoint', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      data: [
        { id: 'r1', content: 'recent one', metadata: '{}', timestamp: '2026-03-19T00:00:00.000Z' },
        { id: 'r2', content: 'recent two', metadata: '{}', timestamp: '2026-03-20T00:00:00.000Z' },
      ],
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const results = await client.getRecent(10);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('r1');
    expect(results[1].id).toBe('r2');
    expect(results[0].score).toBe(1.0);
  });

  it('should pass the requested limit to the API', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0, data: [] }));

    const client = new ZillizClient(BASE_CONFIG);
    await client.getRecent(25);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.limit).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — delete()
// ---------------------------------------------------------------------------

describe('ZillizClient.delete()', () => {
  it('should return true when Zilliz responds ok for a valid UUID', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0 }, true));

    const client = new ZillizClient(BASE_CONFIG);
    const result = await client.delete('550e8400-e29b-41d4-a716-446655440000');

    expect(result).toBe(true);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/entities/delete');
  });

  it('should return false and skip the HTTP call for an invalid UUID', async () => {
    const client = new ZillizClient(BASE_CONFIG);
    const result = await client.delete('not-a-uuid');

    expect(result).toBe(false);
    // fetch must NOT have been called — invalid UUID is rejected before the network
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return false when HTTP response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 1 }, false, 500));

    const client = new ZillizClient(BASE_CONFIG);
    const result = await client.delete('550e8400-e29b-41d4-a716-446655440000');

    expect(result).toBe(false);
  });

  it('should embed the sanitized ID in the filter expression', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0 }, true));

    const client = new ZillizClient(BASE_CONFIG);
    await client.delete('550e8400-e29b-41d4-a716-446655440000');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.filter).toContain('550e8400-e29b-41d4-a716-446655440000');
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — count()
// ---------------------------------------------------------------------------

describe('ZillizClient.count()', () => {
  it('should return the rowCount from describe response', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      code: 0,
      collection: { rowCount: 42 },
    }));

    const client = new ZillizClient(BASE_CONFIG);
    const count = await client.count();

    expect(count).toBe(42);
  });

  it('should return 0 when collection field is absent', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    const count = await client.count();

    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — close()
// ---------------------------------------------------------------------------

describe('ZillizClient.close()', () => {
  it('should resolve without throwing', async () => {
    const client = new ZillizClient(BASE_CONFIG);
    await expect(client.close()).resolves.not.toThrow();
  });

  it('should allow re-initialization after close', async () => {
    fetchMock.mockResolvedValue(mockResponse({ code: 0 }));

    const client = new ZillizClient(BASE_CONFIG);
    await client.initialize();
    await client.close();
    // After close, isInitialized is reset — next initialize should fire fetch again
    await client.initialize();

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// ZillizClient — hybrid search feature flag
// ---------------------------------------------------------------------------

describe('ZillizClient.isHybridSearchEnabled()', () => {
  it('should return false by default', () => {
    const client = new ZillizClient(BASE_CONFIG);
    expect(client.isHybridSearchEnabled()).toBe(false);
  });

  it('should return true when enableHybridSearch is set', () => {
    const client = new ZillizClient({ ...BASE_CONFIG, enableHybridSearch: true });
    expect(client.isHybridSearchEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read paths must not swallow a rejected query into an empty result
//
// Regression: Zilliz answers HTTP 200 with a non-zero `code` when it refuses a
// query. `data.data || data.results || []` turned that into a successful empty
// search, so a hybrid query against a non-existent `sparse_embedding` field
// (code 1801) returned "no matches" on every recall for months instead of
// failing. An error and an empty result must never be the same value.
// ---------------------------------------------------------------------------

describe('ZillizClient error-vs-empty distinction', () => {
  const REJECTED = {
    code: 1801,
    message: 'can only accept json format request, error: cannot find a vector field named: sparse_embedding',
  };

  it('search() should throw on a non-zero code rather than return []', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(REJECTED));
    const client = new ZillizClient(BASE_CONFIG);

    await expect(client.search('anything', 5)).rejects.toThrow(/code 1801/);
  });

  it('search() error should name the operation and collection for diagnosis', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(REJECTED));
    const client = new ZillizClient(BASE_CONFIG);

    await expect(client.search('anything', 5)).rejects.toThrow(/search failed on collection 'test-memories'/);
  });

  it('search() should still return [] for a legitimately empty result (code 0)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 0, data: [] }));
    const client = new ZillizClient(BASE_CONFIG);

    await expect(client.search('no matches', 5)).resolves.toEqual([]);
  });

  it('search() should treat an absent code as success', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ data: [] }));
    const client = new ZillizClient(BASE_CONFIG);

    await expect(client.search('no code field', 5)).resolves.toEqual([]);
  });

  it('hybridSearch() should throw on the sparse_embedding rejection', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(REJECTED));
    const client = new ZillizClient({ ...BASE_CONFIG, enableHybridSearch: true });

    await expect(
      client.hybridSearch('anything', 5, { rerankStrategy: 'rrf' } as HybridSearchOptions)
    ).rejects.toThrow(/hybrid_search failed .*\(code 1801\)/);
  });

  it('get() should throw rather than report the memory as missing', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 500, message: 'internal error' }));
    const client = new ZillizClient(BASE_CONFIG);

    // Returning null here would tell a caller verifying a write that it never landed.
    await expect(client.get('550e8400-e29b-41d4-a716-446655440000')).rejects.toThrow(/get failed/);
  });

  it('getRecent() should throw on a non-zero code', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ code: 500, message: 'internal error' }));
    const client = new ZillizClient(BASE_CONFIG);

    await expect(client.getRecent(10)).rejects.toThrow(/getRecent failed/);
  });
});
