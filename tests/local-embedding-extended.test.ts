/**
 * LocalEmbeddingGenerator Tests
 * Covers constructor, generateEmbedding (hash/ollama/transformers paths),
 * getDimension, getProvider, cosineSimilarity static method
 */

import { LocalEmbeddingGenerator } from '../src/storage/embeddings/local-embedding';

describe('LocalEmbeddingGenerator', () => {
  describe('constructor and defaults', () => {
    it('should create with default config (hash provider)', () => {
      const gen = new LocalEmbeddingGenerator();
      expect(gen).toBeDefined();
    });

    it('should use hash provider by default', () => {
      const gen = new LocalEmbeddingGenerator();
      expect(gen.getProvider()).toBe('hash');
    });

    it('should use configured provider', () => {
      const gen = new LocalEmbeddingGenerator({ provider: 'ollama' });
      expect(gen.getProvider()).toBe('ollama');
    });

    it('should use configured provider transformers', () => {
      const gen = new LocalEmbeddingGenerator({ provider: 'transformers' });
      expect(gen.getProvider()).toBe('transformers');
    });
  });

  describe('getDimension', () => {
    it('should return 768 for default nomic-embed-text model', () => {
      const gen = new LocalEmbeddingGenerator({ model: 'nomic-embed-text' });
      expect(gen.getDimension()).toBe(768);
    });

    it('should return 384 for all-MiniLM-L6-v2 model', () => {
      const gen = new LocalEmbeddingGenerator({ model: 'all-MiniLM-L6-v2' });
      expect(gen.getDimension()).toBe(384);
    });

    it('should return 768 for all-mpnet-base-v2 model', () => {
      const gen = new LocalEmbeddingGenerator({ provider: 'hash', model: 'all-mpnet-base-v2' });
      expect(gen.getDimension()).toBe(768);
    });

    it('should fall back to configured dimension for unknown model', () => {
      const gen = new LocalEmbeddingGenerator({ provider: 'hash', model: 'custom-model', dimension: 512 });
      expect(gen.getDimension()).toBe(512);
    });

    it('should fall back to default dimension 768 for unknown model without explicit dimension', () => {
      const gen = new LocalEmbeddingGenerator({ provider: 'hash', model: 'totally-unknown-model' });
      expect(gen.getDimension()).toBe(768);
    });
  });

  describe('generateEmbedding with hash provider', () => {
    let gen: LocalEmbeddingGenerator;

    beforeEach(() => {
      gen = new LocalEmbeddingGenerator({ provider: 'hash' });
    });

    it('should generate an embedding array', async () => {
      const embedding = await gen.generateEmbedding('hello world');
      expect(Array.isArray(embedding)).toBe(true);
    });

    it('should generate embedding of correct length', async () => {
      const embedding = await gen.generateEmbedding('test content');
      expect(embedding.length).toBe(gen.getDimension());
    });

    it('should generate consistent embeddings for same input', async () => {
      const e1 = await gen.generateEmbedding('deterministic content');
      const e2 = await gen.generateEmbedding('deterministic content');
      expect(e1).toEqual(e2);
    });

    it('should generate different embeddings for different input', async () => {
      const e1 = await gen.generateEmbedding('content A');
      const e2 = await gen.generateEmbedding('content B');
      expect(e1).not.toEqual(e2);
    });

    it('should handle empty string input', async () => {
      const embedding = await gen.generateEmbedding('');
      expect(embedding.length).toBe(gen.getDimension());
    });

    it('should handle unicode content', async () => {
      const embedding = await gen.generateEmbedding('Unicode: 你好 αβγ 🚀');
      expect(embedding.length).toBe(gen.getDimension());
    });

    it('should handle very long content', async () => {
      const longContent = 'word '.repeat(1000);
      const embedding = await gen.generateEmbedding(longContent);
      expect(embedding.length).toBe(gen.getDimension());
    });
  });

  describe('generateEmbedding with ollama provider', () => {
    let gen: LocalEmbeddingGenerator;

    beforeEach(() => {
      gen = new LocalEmbeddingGenerator({
        provider: 'ollama',
        model: 'nomic-embed-text',
        ollamaUrl: 'http://localhost:99999', // unreachable
        timeout: 100,
      });
    });

    it('should fall back to hash when ollama is unreachable', async () => {
      const embedding = await gen.generateEmbedding('test content');
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBeGreaterThan(0);
    });
  });

  describe('generateEmbedding with transformers provider', () => {
    let gen: LocalEmbeddingGenerator;

    beforeEach(() => {
      gen = new LocalEmbeddingGenerator({
        provider: 'transformers',
        model: 'all-MiniLM-L6-v2',
      });
    });

    it('should fall back to hash when transformers library is unavailable', async () => {
      const embedding = await gen.generateEmbedding('test content');
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBeGreaterThan(0);
    });
  });

  describe('cosineSimilarity static method', () => {
    it('should return 1 for identical vectors', () => {
      const v = [1, 0, 0, 0];
      expect(LocalEmbeddingGenerator.cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0];
      const b = [0, 1];
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('should return -1 for opposite vectors', () => {
      const a = [1, 0];
      const b = [-1, 0];
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });

    it('should return 0 for zero vector', () => {
      const a = [0, 0];
      const b = [1, 0];
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBe(0);
    });

    it('should throw for mismatched dimensions', () => {
      expect(() =>
        LocalEmbeddingGenerator.cosineSimilarity([1, 2], [1, 2, 3])
      ).toThrow('Embeddings must have same dimension');
    });

    it('should handle normalized vectors', () => {
      const a = [0.6, 0.8];
      const b = [0.6, 0.8];
      expect(LocalEmbeddingGenerator.cosineSimilarity(a, b)).toBeCloseTo(1.0);
    });
  });
});
