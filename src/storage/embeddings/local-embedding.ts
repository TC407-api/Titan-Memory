/**
 * Local Embedding Generator
 * Fallback using local models (Ollama) or transformers.js
 */

import { IEmbeddingGenerator } from '../vector-storage.js';
import { simpleHash } from '../../utils/hash.js';

export interface LocalEmbeddingConfig {
  provider: 'ollama' | 'transformers' | 'hash';
  model?: string;
  dimension?: number;
  ollamaUrl?: string;
  timeout?: number;
}

const DEFAULT_CONFIG: Required<LocalEmbeddingConfig> = {
  provider: 'hash',
  model: 'nomic-embed-text',
  dimension: 768,
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  timeout: 30000,
};

/**
 * Local embedding generator with multiple fallback options
 */
export class LocalEmbeddingGenerator implements IEmbeddingGenerator {
  private readonly config: Required<LocalEmbeddingConfig>;

  constructor(config?: Partial<LocalEmbeddingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate embedding for text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    switch (this.config.provider) {
      case 'ollama':
        return this.generateOllamaEmbedding(text);
      case 'transformers':
        return this.generateTransformersEmbedding(text);
      case 'hash':
      default:
        return this.generateHashEmbedding(text);
    }
  }

  /**
   * Generate embedding using Ollama (local LLM server)
   */
  private async generateOllamaEmbedding(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(`${this.config.ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          prompt: text,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(`Ollama embedding failed, falling back to hash: ${response.status}`);
        return this.generateHashEmbedding(text);
      }

      const data = await response.json() as { embedding: number[] };
      return data.embedding;
    } catch (error) {
      console.warn('Ollama not available, falling back to hash embedding:', error);
      return this.generateHashEmbedding(text);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Generate embedding using transformers.js (browser/Node.js)
   * Note: Requires @xenova/transformers to be installed
   */
  private async generateTransformersEmbedding(text: string): Promise<number[]> {
    try {
      // Dynamic import to avoid loading if not used
      // @ts-expect-error - @xenova/transformers is an optional dependency
      const { pipeline } = await import('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data as Float32Array);
    } catch (error) {
      console.warn('Transformers.js not available, falling back to hash embedding:', error);
      return this.generateHashEmbedding(text);
    }
  }

  /**
   * Generate deterministic hash-based pseudo-embedding (fallback)
   * Provides consistent embeddings without external dependencies
   */
  private generateHashEmbedding(text: string): number[] {
    const hash = simpleHash(text);
    const embedding: number[] = [];

    // Generate deterministic embedding from hash
    for (let i = 0; i < this.config.dimension; i++) {
      // Use different transformations of the hash for each dimension
      const seed = hash * (i + 1);
      embedding.push(Math.sin(seed) * Math.cos(seed * 0.1) * 0.5);
    }

    // Normalize the embedding
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  getDimension(): number {
    // Model dimensions
    const modelDimensions: Record<string, number> = {
      'nomic-embed-text': 768,
      'all-MiniLM-L6-v2': 384,
      'all-mpnet-base-v2': 768,
    };
    return modelDimensions[this.config.model] || this.config.dimension;
  }

  /**
   * Get the provider being used
   */
  getProvider(): string {
    return this.config.provider;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have same dimension');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
