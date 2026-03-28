/**
 * Tests for src/storage/embeddings/local-embedding.ts
 * Covers LocalEmbeddingGenerator: hash provider, ollama provider (mocked),
 * transformers provider (mocked), getDimension, getProvider, and
 * static cosineSimilarity.
 */

import { LocalEmbeddingGenerator, LocalEmbeddingConfig } from '../src/storage/embeddings/local-embedding';

// ---------------------------------------------------------------------------
// Mock global fetch for Ollama tests
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGenerator(config?: Partial<LocalEmbeddingConfig>): LocalEmbeddingGenerator {
  return new LocalEmbeddingGenerator(config as LocalEmbeddingConfig);
}

function makeVector(dim: number, fill: number): number[] {
  return Array(dim).fill(fill);
}

// ---------------------------------------------------------------------------
// constructor / defaults
// ---------------------------------------------------------------------------

describe('LocalEmbeddingGenerator', () => {
  describe('constructor', () => {
    it('should default to hash provider', () => {
      const gen = makeGenerator();
      expect(gen.getProvider()).toBe('hash');
    });

    it('should accept an explicit provider', () => {
      const gen = makeGenerator({ provider: 'ollama' });
      expect(gen.getProvider()).toBe('ollama');
    });

    it('should default dimension to 768', () => {
      const gen = makeGenerator();
      expect(gen.getDimension()).toBe(768);
    });
  });

  // ---------------------------------------------------------------------------
  // getDimension
  // ---------------------------------------------------------------------------

  describe('getDimension', () => {
    it('should return 768 for nomic-embed-text model', () => {
      const gen = makeGenerator({ model: 'nomic-embed-text' });
      expect(gen.getDimension()).toBe(768);
    });

    it('should return 384 for all-MiniLM-L6-v2 model', () => {
      const gen = makeGenerator({ model: 'all-MiniLM-L6-v2' });
      expect(gen.getDimension()).toBe(384);
    });

    it('should return 768 for all-mpnet-base-v2 model', () => {
      const gen = makeGenerator({ model: 'all-mpnet-base-v2' });
      expect(gen.getDimension()).toBe(768);
    });

    it('should fall back to the configured dimension for unknown models', () => {
      const gen = makeGenerator({ model: 'custom-unknown', dimension: 512 });
      expect(gen.getDimension()).toBe(512);
    });
  });

  // ---------------------------------------------------------------------------
  // getProvider
  // ---------------------------------------------------------------------------

  describe('getProvider', () => {
    it('should return hash for hash provider', () => {
      expect(makeGenerator({ provider: 'hash' }).getProvider()).toBe('hash');
    });

    it('should return ollama for ollama provider', () => {
      expect(makeGenerator({ provider: 'ollama' }).getProvider()).toBe('ollama');
    });

    it('should return transformers for transformers provider', () => {
      expect(makeGenerator({ provider: 'transformers' }).getProvider()).toBe('transformers');
    });
  });

  // ---------------------------------------------------------------------------
  // generateEmbedding — hash provider
  // ---------------------------------------------------------------------------

  describe('generateEmbedding (hash provider)', () => {
    it('should return an array with the configured dimension', async () => {
      const gen = makeGenerator({ provider: 'hash', dimension: 64 });
      const embedding = await gen.generateEmbedding('hello world');
      expect(embedding.length).toBe(64);
    });

    it('should return numbers between -1 and 1 (normalized)', async () => {
      const gen = makeGenerator({ provider: 'hash', dimension: 32 });
      const embedding = await gen.generateEmbedding('test content');
      for (const v of embedding) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('should return a unit-normalised vector (L2 norm ≈ 1)', async () => {
      const gen = makeGenerator({ provider: 'hash', dimension: 64 });
      const embedding = await gen.generateEmbedding('normalised check');
      const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 5);
    });

    it('should be deterministic for the same input', async () => {
      const gen = makeGenerator({ provider: 'hash', dimension: 16 });
      const a = await gen.generateEmbedding('deterministic');
      const b = await gen.generateEmbedding('deterministic');
      expect(a).toEqual(b);
    });

    it('should produce different embeddings for different inputs', async () => {
      const gen = makeGenerator({ provider: 'hash', dimension: 16 });
      const a = await gen.generateEmbedding('input A');
      const b = await gen.generateEmbedding('input B');
      expect(a).not.toEqual(b);
    });

    it('should handle empty string without throwing', async () => {
      const gen = makeGenerator({ provider: 'hash', dimension: 16 });
      const embedding = await gen.generateEmbedding('');
      expect(embedding.length).toBe(16);
    });

    it('should handle very long input without throwing', async () => {
      const gen = makeGenerator({ provider: 'hash', dimension: 16 });
      const embedding = await gen.generateEmbedding('a'.repeat(50000));
      expect(embedding.length).toBe(16);
    });
  });

  // ---------------------------------------------------------------------------
  // generateEmbedding — ollama provider (mocked fetch)
  // ---------------------------------------------------------------------------

  describe('generateEmbedding (ollama provider)', () => {
    it('should call the Ollama API with correct payload', async () => {
      const fakeEmbedding = Array(768).fill(0.1);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: fakeEmbedding }),
      } as any);

      const gen = makeGenerator({ provider: 'ollama', model: 'nomic-embed-text', dimension: 768 });
      const result = await gen.generateEmbedding('test text');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/embeddings');
      const body = JSON.parse(opts.body as string);
      expect(body.prompt).toBe('test text');
      expect(result).toEqual(fakeEmbedding);
    });

    it('should fall back to hash embedding when Ollama returns non-ok status', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as any);

      const gen = makeGenerator({ provider: 'ollama', dimension: 16 });
      const result = await gen.generateEmbedding('fallback test');

      expect(result.length).toBe(16);
    });

    it('should fall back to hash embedding when fetch throws (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network unreachable'));

      const gen = makeGenerator({ provider: 'ollama', dimension: 16 });
      const result = await gen.generateEmbedding('network error test');

      expect(result.length).toBe(16);
    });

    it('should use custom ollamaUrl from config', async () => {
      const fakeEmbedding = Array(4).fill(0.5);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: fakeEmbedding }),
      } as any);

      const gen = makeGenerator({
        provider: 'ollama',
        ollamaUrl: 'http://custom-host:9999',
        dimension: 4,
      });
      await gen.generateEmbedding('custom url test');

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('http://custom-host:9999');
    });
  });

  // ---------------------------------------------------------------------------
  // generateEmbedding — transformers provider (mocked dynamic import)
  // ---------------------------------------------------------------------------

  describe('generateEmbedding (transformers provider)', () => {
    it('should fall back to hash embedding when @xenova/transformers is unavailable', async () => {
      // The dynamic import will fail because the optional dep is not installed
      const gen = makeGenerator({ provider: 'transformers', dimension: 16 });
      const result = await gen.generateEmbedding('transformers fallback');
      expect(result.length).toBe(16);
    });
  });

  // ---------------------------------------------------------------------------
  // static cosineSimilarity
  // ---------------------------------------------------------------------------

  describe('cosineSimilarity (static)', () => {
    it('should return 1.0 for identical non-zero vectors', () => {
      const v = [1, 2, 3, 4];
      expect(LocalEmbeddingGenerator.cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it('should return 0.0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('should return -1.0 for opposite vectors', () => {
      const a = [1, 0];
      const b = [-1, 0];
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });

    it('should return 0.0 when either vector is all zeros', () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBe(0);
      expect(LocalEmbeddingGenerator.cosineSimilarity(b, a)).toBe(0);
    });

    it('should throw when vectors have different dimensions', () => {
      const a = [1, 2];
      const b = [1, 2, 3];
      expect(() => LocalEmbeddingGenerator.cosineSimilarity(a, b)).toThrow();
    });

    it('should compute correct value for known vectors', () => {
      const a = [1, 0];
      const b = [1, 1];
      // cos(45°) = 1/√2 ≈ 0.7071
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBeCloseTo(0.7071, 3);
    });

    it('should handle single-element vectors', () => {
      expect(LocalEmbeddingGenerator.cosineSimilarity([5], [3])).toBeCloseTo(1.0);
    });

    it('should handle large dimension vectors', () => {
      const a = makeVector(1024, 1);
      const b = makeVector(1024, 1);
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBeCloseTo(1.0);
    });
  });
});
