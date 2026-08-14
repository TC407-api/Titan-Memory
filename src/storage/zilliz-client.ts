/**
 * Zilliz Cloud Vector Storage Client
 * Implements IVectorStorage interface for Zilliz Cloud
 */

import { MemoryEntry } from '../types.js';
import { simpleHash } from '../utils/hash.js';
import { isValidUUID, sanitizeFilterValue } from '../utils/auth.js';
import {
  IVectorStorage,
  IEmbeddingGenerator,
  VectorSearchResult,
  VectorStorageConfig,
  HybridSearchOptions,
} from './vector-storage.js';

/**
 * Default embedding generator using deterministic hash-based pseudo-embeddings
 * In production, replace with OpenAI, Cohere, or other embedding service
 */
export class DefaultEmbeddingGenerator implements IEmbeddingGenerator {
  private readonly dimension: number;

  constructor(dimension: number = 1024) { // Match voyage-3-large default
    this.dimension = dimension;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Deterministic pseudo-embedding based on content hash
    // Production: Replace with actual embedding API call
    const hash = simpleHash(text);
    const embedding: number[] = [];
    for (let i = 0; i < this.dimension; i++) {
      embedding.push(Math.sin(hash * (i + 1)) * 0.5);
    }
    return embedding;
  }

  getDimension(): number {
    return this.dimension;
  }
}

/**
 * Shape of a Zilliz v2 REST search / hybrid_search response body.
 * `code` is 0 on success — including a search that legitimately matched nothing.
 */
interface ZillizSearchResponse {
  code?: number;
  message?: string;
  data?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
}

/**
 * Zilliz Cloud client implementing the vector storage interface
 */
export class ZillizClient implements IVectorStorage {
  private readonly uri: string;
  private readonly token: string;
  private readonly collection: string;
  private readonly dimension: number;
  private readonly metricType: string;
  private readonly embeddingGenerator: IEmbeddingGenerator;
  private enableHybridSearch: boolean;
  private readonly bm25K1: number;
  private readonly bm25B: number;
  private isInitialized: boolean = false;

  constructor(
    config: VectorStorageConfig,
    embeddingGenerator?: IEmbeddingGenerator
  ) {
    this.uri = config.uri;
    this.token = config.token;
    this.collection = config.collection;
    this.dimension = config.dimension ?? 1024; // voyage-3-large default
    this.metricType = config.metricType ?? 'COSINE';
    this.embeddingGenerator = embeddingGenerator ?? new DefaultEmbeddingGenerator(this.dimension);
    // Hybrid search configuration
    this.enableHybridSearch = config.enableHybridSearch ?? false;
    this.bm25K1 = config.bm25K1 ?? 1.2;
    this.bm25B = config.bm25B ?? 0.75;
  }

  /**
   * Check if hybrid search is available
   */
  isHybridSearchEnabled(): boolean {
    return this.enableHybridSearch;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      const response = await fetch(`${this.uri}/v2/vectordb/collections/describe`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ collectionName: this.collection }),
      });

      // Zilliz REST API v2 returns HTTP 200 even for errors,
      // with code != 0 in JSON body when collection doesn't exist
      const data = await response.json() as { code: number };
      if (!response.ok || data.code !== 0) {
        // Collection doesn't exist, create it
        await this.createCollection();
      }
      this.isInitialized = true;
    } catch {
      // Fallback to offline mode
      console.warn('Could not connect to Zilliz, running in offline mode');
      this.isInitialized = true;
    }
  }

  private async createCollection(): Promise<void> {
    if (this.enableHybridSearch) {
      const success = await this.createHybridCollection();
      if (success) return;
      // Hybrid creation failed — fall back to regular collection
      this.enableHybridSearch = false;
    }

    await this.createRegularCollection();
  }

  private async createRegularCollection(): Promise<void> {
    // Create collection with explicit schema (VarChar id for UUID support)
    const schema = {
      autoId: false,
      enableDynamicField: true,
      fields: [
        { fieldName: 'id', dataType: 'VarChar', isPrimary: true, elementTypeParams: { max_length: '64' } },
        { fieldName: 'content', dataType: 'VarChar', elementTypeParams: { max_length: '8000' } },
        { fieldName: 'embedding', dataType: 'FloatVector', elementTypeParams: { dim: String(this.dimension) } },
        { fieldName: 'timestamp', dataType: 'VarChar', elementTypeParams: { max_length: '64' } },
        { fieldName: 'metadata', dataType: 'VarChar', elementTypeParams: { max_length: '16000' } },
      ],
    };

    const resp = await fetch(`${this.uri}/v2/vectordb/collections/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collectionName: this.collection,
        schema,
      }),
    });
    const data = await resp.json() as { code: number; message?: string };
    if (data.code !== 0) {
      console.warn(`Failed to create collection ${this.collection}: ${data.message}`);
    }

    // Create index for the embedding field
    await fetch(`${this.uri}/v2/vectordb/indexes/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collectionName: this.collection,
        indexParams: [{
          fieldName: 'embedding',
          indexName: 'embedding_idx',
          indexType: 'AUTOINDEX',
          metricType: this.metricType,
        }],
      }),
    });

    // Load collection into memory for searching
    await this.loadCollection();
  }

  /**
   * Create collection with hybrid search schema supporting both dense and sparse vectors
   * Returns true on success, false on failure (caller should fall back to regular collection)
   */
  private async createHybridCollection(): Promise<boolean> {
    // Define schema with both dense and sparse vector fields
    const schema = {
      autoId: false,
      enableDynamicField: true,
      fields: [
        { fieldName: 'id', dataType: 'VarChar', isPrimary: true, elementTypeParams: { max_length: '64' } },
        { fieldName: 'content', dataType: 'VarChar', elementTypeParams: { max_length: '8000', enable_analyzer: true } },
        { fieldName: 'embedding', dataType: 'FloatVector', elementTypeParams: { dim: String(this.dimension) } },
        { fieldName: 'sparse_embedding', dataType: 'SparseFloatVector' },
        { fieldName: 'timestamp', dataType: 'VarChar', elementTypeParams: { max_length: '64' } },
        { fieldName: 'metadata', dataType: 'VarChar', elementTypeParams: { max_length: '16000' } },
      ],
      functions: [
        {
          name: 'content_bm25',
          type: 'BM25',
          inputFieldNames: ['content'],
          outputFieldNames: ['sparse_embedding'],
        },
      ],
    };

    try {
      // Create collection with schema
      const resp = await fetch(`${this.uri}/v2/vectordb/collections/create`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          collectionName: this.collection,
          schema,
        }),
      });
      const data = await resp.json() as { code: number; message?: string };
      if (data.code !== 0) {
        console.warn(`Hybrid collection creation failed for ${this.collection}: ${data.message}`);
        return false;
      }

      // Create indexes for both dense and sparse vectors
      await this.createHybridIndexes();

      // Load collection into memory for searching
      await this.loadCollection();

      return true;
    } catch (error) {
      console.warn(`Hybrid collection creation error for ${this.collection}:`, error);
      return false;
    }
  }

  /**
   * Create indexes for hybrid search (dense + sparse)
   */
  private async createHybridIndexes(): Promise<void> {
    // Create index for dense vectors
    await fetch(`${this.uri}/v2/vectordb/indexes/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collectionName: this.collection,
        indexParams: [
          {
            fieldName: 'embedding',
            indexName: 'dense_idx',
            indexType: 'AUTOINDEX',
            metricType: this.metricType,
          },
          {
            fieldName: 'sparse_embedding',
            indexName: 'sparse_idx',
            indexType: 'AUTOINDEX',
            metricType: 'BM25',
            params: {
              bm25_k1: this.bm25K1,
              bm25_b: this.bm25B,
            },
          },
        ],
      }),
    });
  }

  /**
   * Load collection into memory for searching
   */
  private async loadCollection(): Promise<void> {
    const resp = await fetch(`${this.uri}/v2/vectordb/collections/load`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ collectionName: this.collection }),
    });
    const data = await resp.json() as { code: number; message?: string };
    if (data.code !== 0) {
      console.warn(`Failed to load collection ${this.collection}: ${data.message}`);
    }
  }

  async insert(entry: MemoryEntry): Promise<void> {
    const embedding = await this.embeddingGenerator.generateEmbedding(entry.content);

    const resp = await fetch(`${this.uri}/v2/vectordb/entities/insert`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collectionName: this.collection,
        data: [{
          id: entry.id,
          content: entry.content,
          embedding,
          timestamp: entry.timestamp.toISOString(),
          metadata: JSON.stringify(entry.metadata),
        }],
      }),
    });
    const data = await resp.json() as { code: number; message?: string };
    if (data.code !== 0) {
      console.warn(`Zilliz insert failed for ${entry.id}: ${data.message}`);
    }
  }

  /**
   * Extract search hits from a Zilliz response body, failing loudly on a rejected query.
   *
   * Zilliz answers HTTP 200 even when it refuses the query — the failure is carried in the
   * body as a non-zero `code` with no `data`. The previous `data.data || data.results || []`
   * collapsed that into an empty array, making a broken search indistinguishable from one
   * that legitimately matched nothing. That hid a query against a non-existent
   * `sparse_embedding` field (code 1801) on every recall for months.
   *
   * A genuinely empty result set comes back as `code: 0` with an empty `data`, so this
   * never fires on "no matches". `code` absent is treated as success for callers/mocks
   * that do not model it.
   */
  private extractSearchHits(
    body: ZillizSearchResponse,
    operation: string,
  ): Array<Record<string, unknown>> {
    if (body.code !== undefined && body.code !== 0) {
      throw new Error(
        `Zilliz ${operation} failed on collection '${this.collection}' ` +
        `(code ${body.code}): ${body.message ?? 'no message'}`
      );
    }
    return body.data || body.results || [];
  }

  async search(query: string, limit: number): Promise<VectorSearchResult[]> {
    const embedding = await this.embeddingGenerator.generateEmbedding(query);

    const response = await fetch(`${this.uri}/v2/vectordb/entities/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collectionName: this.collection,
        data: [embedding],
        annsField: 'embedding',
        limit,
        outputFields: ['id', 'content', 'timestamp', 'metadata'],
        consistencyLevel: 'Strong',
      }),
    });

    const data = await response.json() as ZillizSearchResponse;
    // Zilliz v2 REST API returns search results in 'data' array
    const results = this.extractSearchHits(data, 'search');
    return results.map((r: Record<string, unknown>) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      if (r.timestamp && !meta.timestamp) {
        meta.timestamp = r.timestamp;
      }
      return {
        id: r.id as string,
        content: r.content as string,
        score: (r.distance ?? r.score ?? 0) as number,
        metadata: meta,
      };
    });
  }

  /**
   * Hybrid search combining dense semantic search with BM25 sparse keyword search
   * Uses Reciprocal Rank Fusion (RRF) or weighted reranking to combine results
   */
  async hybridSearch(
    query: string,
    limit: number,
    options: HybridSearchOptions = { rerankStrategy: 'rrf' }
  ): Promise<VectorSearchResult[]> {
    if (!this.enableHybridSearch) {
      // Fallback to regular search if hybrid not enabled
      return this.search(query, limit);
    }

    const embedding = await this.embeddingGenerator.generateEmbedding(query);
    const candidateLimit = limit * 3; // Retrieve more candidates for reranking

    // Build reranker configuration based on strategy
    let rerank: Record<string, unknown>;
    if (options.rerankStrategy === 'weighted') {
      rerank = {
        strategy: 'weighted',
        params: {
          weights: [options.denseWeight ?? 0.5, options.sparseWeight ?? 0.5],
        },
      };
    } else {
      // Default to RRF
      rerank = {
        strategy: 'rrf',
        params: {
          k: options.rrfK ?? 60,
        },
      };
    }

    // Build hybrid search request
    const searchRequest = {
      collectionName: this.collection,
      search: [
        {
          // Dense vector search (semantic)
          data: [embedding],
          annsField: 'embedding',
          limit: candidateLimit,
          params: {
            metric_type: this.metricType,
          },
        },
        {
          // Sparse vector search (BM25 keyword)
          data: [query], // Raw text - Zilliz converts to sparse vector via BM25 function
          annsField: 'sparse_embedding',
          limit: candidateLimit,
          params: {
            metric_type: 'BM25',
          },
        },
      ],
      rerank,
      limit,
      outputFields: ['id', 'content', 'timestamp', 'metadata'],
    };

    // Strong consistency ensures recently inserted data is searchable
    (searchRequest as Record<string, unknown>).consistencyLevel = 'Strong';

    // Add filter if provided
    if (options.filter) {
      (searchRequest as Record<string, unknown>).filter = options.filter;
    }

    const response = await fetch(`${this.uri}/v2/vectordb/entities/hybrid_search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(searchRequest),
    });

    const data = await response.json() as ZillizSearchResponse;
    const results = this.extractSearchHits(data, 'hybrid_search');
    return results.map((r: Record<string, unknown>) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      if (r.timestamp && !meta.timestamp) {
        meta.timestamp = r.timestamp;
      }
      return {
        id: r.id as string,
        content: r.content as string,
        score: (r.distance ?? r.score ?? 0) as number,
        metadata: meta,
      };
    });
  }

  async get(id: string): Promise<VectorSearchResult | null> {
    const response = await fetch(`${this.uri}/v2/vectordb/entities/get`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collectionName: this.collection,
        // Zilliz v2 REST expects `id`, not `ids` — `ids` is rejected with code 1802
        // ("Field validation for 'ID' failed on the 'required' tag"). That rejection used to
        // be swallowed into an empty array and returned as null, i.e. "memory not found",
        // so every get() against real Zilliz silently reported nothing existed.
        id: [id],
        outputFields: ['id', 'content', 'timestamp', 'metadata'],
      }),
    });

    const data = await response.json() as ZillizSearchResponse;
    // Without this check a rejected get returns null — i.e. "that memory does not exist",
    // which is exactly the wrong answer to give a caller verifying that a write landed.
    const results = this.extractSearchHits(data, 'get');
    if (results.length > 0) {
      const r = results[0];
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      if (r.timestamp && !meta.timestamp) {
        meta.timestamp = r.timestamp;
      }
      return {
        id: r.id as string,
        content: r.content as string,
        score: 1.0,
        metadata: meta,
      };
    }
    return null;
  }

  async getRecent(limit: number): Promise<VectorSearchResult[]> {
    const response = await fetch(`${this.uri}/v2/vectordb/entities/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collectionName: this.collection,
        filter: '',
        limit,
        outputFields: ['id', 'content', 'timestamp', 'metadata'],
        consistencyLevel: 'Strong',
      }),
    });

    const data = await response.json() as ZillizSearchResponse;
    const results = this.extractSearchHits(data, 'getRecent');
    return results.map((r: Record<string, unknown>) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      // Inject top-level timestamp into metadata so layers can access it
      if (r.timestamp && !meta.timestamp) {
        meta.timestamp = r.timestamp;
      }
      return { id: r.id as string, content: r.content as string, score: 1.0, metadata: meta };
    });
  }

  async delete(id: string): Promise<boolean> {
    // Validate ID format to prevent injection attacks
    if (!isValidUUID(id)) {
      console.warn(`Invalid UUID format for delete: ${id}`);
      return false;
    }

    // Sanitize the ID value even after validation for defense in depth
    const sanitizedId = sanitizeFilterValue(id);

    const response = await fetch(`${this.uri}/v2/vectordb/entities/delete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collectionName: this.collection,
        filter: `id == "${sanitizedId}"`,
      }),
    });

    return response.ok;
  }

  async count(): Promise<number> {
    const response = await fetch(`${this.uri}/v2/vectordb/collections/describe`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ collectionName: this.collection }),
    });

    const data = await response.json() as { collection?: { rowCount: number } };
    return data.collection?.rowCount || 0;
  }

  async close(): Promise<void> {
    this.isInitialized = false;
    // Cleanup if needed
  }
}
