/**
 * Layer 3: Long-Term Memory (Titans/MIRAS-inspired)
 * Surprise-based selective storage with momentum and adaptive forgetting
 * Uses Zilliz Cloud for vector storage with surprise scores
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseMemoryLayer } from './base.js';
import { MemoryEntry, MemoryLayer, QueryOptions, QueryResult } from '../types.js';
import { calculateSurprise, calculateMomentum, calculateDecay } from '../utils/surprise.js';
import { getConfig, getProjectCollectionName } from '../utils/config.js';
import { IVectorStorage, ZillizClient, VoyageReranker, createEmbeddingGenerator } from '../storage/index.js';

export class LongTermMemoryLayer extends BaseMemoryLayer {
  // Use circular buffer for O(1) momentum calculation instead of array shift O(n)
  private readonly SURPRISE_BUFFER_SIZE = 100;
  private recentSurprises: Float64Array = new Float64Array(this.SURPRISE_BUFFER_SIZE);
  private surpriseIndex: number = 0;
  private surpriseCount: number = 0;
  private static readonly MAX_CACHE_SIZE = 1000;
  private memoryCache: Map<string, MemoryEntry> = new Map();
  private vectorStorage: IVectorStorage | null = null;
  private reranker: VoyageReranker | null = null;

  constructor(projectId?: string, vectorStorage?: IVectorStorage) {
    super(MemoryLayer.LONG_TERM, projectId);
    // Allow dependency injection for testing
    if (vectorStorage) {
      this.vectorStorage = vectorStorage;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const config = getConfig();

    // Use injected storage or create default ZillizClient
    if (!this.vectorStorage && !config.offlineMode && config.zillizUri && config.zillizToken) {
      // Use project-specific collection name for physical isolation
      const collectionName = getProjectCollectionName(this.projectId) + '_longterm';

      // Create embedding generator from config (Voyage AI when API key available, hash fallback)
      const embeddingConfig = {
        ...config.embedding,
        apiKey: config.embedding?.apiKey || process.env.VOYAGE_API_KEY || '',
      };
      // Use Voyage provider if API key is available, regardless of config default
      if (embeddingConfig.apiKey && embeddingConfig.provider === 'hash') {
        embeddingConfig.provider = 'voyage' as const;
      }
      const embeddingGenerator = embeddingConfig.apiKey && embeddingConfig.provider === 'voyage'
        ? createEmbeddingGenerator(embeddingConfig)
        : undefined;

      this.vectorStorage = new ZillizClient({
        uri: config.zillizUri,
        token: config.zillizToken,
        collection: collectionName,
        dimension: embeddingConfig.dimension ?? 1024,
        // Hybrid search configuration
        enableHybridSearch: config.hybridSearch?.enabled ?? false,
        bm25K1: config.hybridSearch?.bm25K1 ?? 1.2,
        bm25B: config.hybridSearch?.bm25B ?? 0.75,
      }, embeddingGenerator);
      await this.vectorStorage.initialize();
    }

    // Initialize reranker if Voyage API key is available
    const voyageKey = config.embedding?.apiKey || process.env.VOYAGE_API_KEY || '';
    if (voyageKey && !config.offlineMode) {
      try {
        this.reranker = new VoyageReranker({ apiKey: voyageKey });
      } catch {
        // Reranker is optional — continue without it
      }
    }

    this.initialized = true;
  }

  /**
   * Store with surprise-based filtering
   */
  async store(entry: Omit<MemoryEntry, 'id' | 'layer'> & { id?: string }): Promise<MemoryEntry> {
    const config = getConfig();

    // Get recent memories for surprise calculation
    const recentMemories = await this.getRecentMemories(50);

    // Calculate surprise score
    const surpriseResult = calculateSurprise(
      entry.content,
      recentMemories,
      config.surpriseThreshold
    );

    // Track surprise for momentum calculation using O(1) circular buffer
    this.recentSurprises[this.surpriseIndex] = surpriseResult.score;
    this.surpriseIndex = (this.surpriseIndex + 1) % this.SURPRISE_BUFFER_SIZE;
    if (this.surpriseCount < this.SURPRISE_BUFFER_SIZE) {
      this.surpriseCount++;
    }

    // Check if we should store (surprise filtering)
    if (config.enableSurpriseFiltering && !surpriseResult.shouldStore) {
      // Return a "ghost" entry that wasn't actually stored
      return {
        id: `ghost_${uuidv4()}`,
        content: entry.content,
        layer: MemoryLayer.LONG_TERM,
        timestamp: entry.timestamp,
        metadata: {
          ...entry.metadata,
          stored: false,
          surpriseScore: surpriseResult.score,
          reason: 'Below surprise threshold',
        },
      };
    }

    const id = entry.id || uuidv4();
    const momentum = calculateMomentum(this.getRecentSurprisesArray());

    const memoryEntry: MemoryEntry = {
      id,
      content: entry.content,
      layer: MemoryLayer.LONG_TERM,
      timestamp: entry.timestamp,
      metadata: {
        ...entry.metadata,
        stored: true,
        surpriseScore: surpriseResult.score,
        momentum,
        decayFactor: 1.0, // Fresh memories have no decay
        lastAccessed: entry.timestamp.toISOString(),
      },
    };

    // Store in Zilliz if available
    if (this.vectorStorage) {
      await this.vectorStorage.insert(memoryEntry);
    }

    // Also cache locally (with eviction)
    this.evictCacheIfNeeded();
    this.memoryCache.set(id, memoryEntry);

    return memoryEntry;
  }

  /**
   * Query with decay-aware scoring
   */
  async query(queryText: string, options?: QueryOptions): Promise<QueryResult> {
    const startTime = performance.now();
    const limit = options?.limit || 10;
    const config = getConfig();
    const includeDecayed = options?.includeDecayed ?? false;

    let memories: MemoryEntry[] = [];

    if (this.vectorStorage) {
      // Use hybrid search if enabled, otherwise fall back to regular search
      const hybridConfig = config.hybridSearch;
      const useHybrid = hybridConfig?.enabled &&
                        this.vectorStorage.isHybridSearchEnabled?.() &&
                        this.vectorStorage.hybridSearch;

      let results;
      if (useHybrid && this.vectorStorage.hybridSearch) {
        // Hybrid search: combines dense semantic + BM25 keyword search
        results = await this.vectorStorage.hybridSearch(queryText, limit * 2, {
          rerankStrategy: hybridConfig.rerankStrategy || 'rrf',
          rrfK: hybridConfig.rrfK || 60,
          denseWeight: hybridConfig.denseWeight || 0.5,
          sparseWeight: hybridConfig.sparseWeight || 0.5,
        });
      } else {
        // Regular dense vector search
        results = await this.vectorStorage.search(queryText, limit * 2);
      }

      // Rerank using Voyage AI for accuracy beyond raw vector similarity
      if (this.reranker && results.length > 1) {
        try {
          const reranked = await this.reranker.rerank(
            queryText,
            results.map(r => r.content),
            limit,
          );
          // Rebuild results in reranked order with reranker scores
          const originalResults = [...results];
          results = reranked.map(rr => ({
            ...originalResults[rr.index],
            score: rr.relevance_score,
          }));
        } catch {
          // Reranker failure is non-blocking — use original vector search order
        }
      }

      memories = results.map(r => {
        // Timestamp can be in metadata or as a separate field; default to now if missing
        const ts = r.metadata.timestamp || r.metadata.lastAccessed;
        const timestamp = ts ? new Date(ts as string) : new Date();
        return {
          id: r.id,
          content: r.content,
          layer: MemoryLayer.LONG_TERM,
          timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
          metadata: {
            ...r.metadata as MemoryEntry['metadata'],
            searchScore: r.score, // Reranker score when available, else Zilliz score
          },
        };
      });
    } else {
      // Fallback to cache
      memories = [...this.memoryCache.values()];
    }

    // Compute timestamp range for recency tiebreaker
    const timestamps = memories.map(m => m.timestamp.getTime());
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const tsRange = Math.max(1, maxTs - minTs);

    // Apply decay filtering and scoring
    const scoredMemories = memories
      .map(m => {
        const createdAt = m.timestamp;
        const lastAccessed = m.metadata.lastAccessed
          ? new Date(m.metadata.lastAccessed as string)
          : createdAt;
        const decay = calculateDecay(createdAt, lastAccessed, config.decayHalfLife);

        // Use reranker/Zilliz similarity score when available,
        // fall back to surpriseScore for cache-only results
        const relevanceScore = (m.metadata.searchScore as number)
          ?? (m.metadata.surpriseScore as number)
          ?? 0.5;

        // Recency tiebreaker: newer memories get up to 20% bonus
        // Helps knowledge-updates where new info should rank above old contradicting info
        const normalizedRecency = (createdAt.getTime() - minTs) / tsRange;
        const recencyTiebreak = normalizedRecency * 0.20;

        return {
          memory: m,
          effectiveScore: relevanceScore * decay + recencyTiebreak,
          decay,
        };
      })
      .filter(item => includeDecayed || item.decay >= 0.1) // Filter heavily decayed unless requested
      .sort((a, b) => b.effectiveScore - a.effectiveScore)
      .slice(0, limit);

    const queryTimeMs = performance.now() - startTime;

    return {
      memories: scoredMemories.map(s => ({
        ...s.memory,
        metadata: {
          ...s.memory.metadata,
          currentDecay: s.decay,
          effectiveScore: s.effectiveScore,
        },
      })),
      layer: MemoryLayer.LONG_TERM,
      queryTimeMs,
      totalFound: scoredMemories.length,
    };
  }

  async get(id: string): Promise<MemoryEntry | null> {
    // Check cache first
    if (this.memoryCache.has(id)) {
      const cached = this.memoryCache.get(id)!;
      // Create a clone to avoid mutating the cached version during read
      // Update lastAccessed on the cache entry (not the returned clone)
      cached.metadata = {
        ...cached.metadata,
        lastAccessed: new Date().toISOString(),
      };
      // Return a deep clone to prevent external mutations
      return {
        ...cached,
        timestamp: new Date(cached.timestamp.getTime()),
        metadata: { ...cached.metadata },
      };
    }

    if (this.vectorStorage) {
      const result = await this.vectorStorage.get(id);
      if (result) {
        const ts = result.metadata.timestamp || result.metadata.lastAccessed;
        const rawTs = ts ? new Date(ts as string) : new Date();
        const memory: MemoryEntry = {
          id: result.id,
          content: result.content,
          layer: MemoryLayer.LONG_TERM,
          timestamp: isNaN(rawTs.getTime()) ? new Date() : rawTs,
          metadata: result.metadata as MemoryEntry['metadata'],
        };
        this.evictCacheIfNeeded();
        this.memoryCache.set(id, memory);
        return memory;
      }
    }

    return null;
  }

  /**
   * Evict oldest cache entries when exceeding max size (simple LRU via Map insertion order)
   */
  private evictCacheIfNeeded(): void {
    if (this.memoryCache.size >= LongTermMemoryLayer.MAX_CACHE_SIZE) {
      const evictCount = Math.floor(LongTermMemoryLayer.MAX_CACHE_SIZE * 0.1);
      const iterator = this.memoryCache.keys();
      for (let i = 0; i < evictCount; i++) {
        const key = iterator.next().value;
        if (key) this.memoryCache.delete(key);
      }
    }
  }

  async delete(id: string): Promise<boolean> {
    this.memoryCache.delete(id);

    if (this.vectorStorage) {
      return await this.vectorStorage.delete(id);
    }

    return true;
  }

  async count(): Promise<number> {
    if (this.vectorStorage) {
      return await this.vectorStorage.count();
    }
    return this.memoryCache.size;
  }

  /**
   * Get recent memories for surprise calculation
   */
  private async getRecentMemories(limit: number): Promise<MemoryEntry[]> {
    if (this.vectorStorage) {
      const results = await this.vectorStorage.getRecent(limit);
      return results.map(r => {
        const ts = r.metadata.timestamp || r.metadata.lastAccessed;
        const timestamp = ts ? new Date(ts as string) : new Date();
        return {
          id: r.id,
          content: r.content,
          layer: MemoryLayer.LONG_TERM,
          timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
          metadata: r.metadata as MemoryEntry['metadata'],
        };
      });
    }

    return [...this.memoryCache.values()]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Prune heavily decayed memories
   */
  async pruneDecayed(threshold: number = 0.05): Promise<number> {
    const config = getConfig();
    const allMemories = await this.getRecentMemories(1000);
    let pruned = 0;

    for (const memory of allMemories) {
      const createdAt = memory.timestamp;
      const lastAccessed = memory.metadata.lastAccessed
        ? new Date(memory.metadata.lastAccessed as string)
        : createdAt;
      const decay = calculateDecay(createdAt, lastAccessed, config.decayHalfLife);

      if (decay < threshold) {
        await this.delete(memory.id);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Get current momentum (used for context capture)
   */
  getCurrentMomentum(): number {
    return calculateMomentum(this.getRecentSurprisesArray());
  }

  /**
   * Convert circular buffer to array for momentum calculation
   * Returns surprises in chronological order (oldest to newest)
   */
  private getRecentSurprisesArray(): number[] {
    if (this.surpriseCount === 0) return [];

    const result: number[] = [];
    const start = this.surpriseCount < this.SURPRISE_BUFFER_SIZE
      ? 0
      : this.surpriseIndex;

    for (let i = 0; i < this.surpriseCount; i++) {
      const idx = (start + i) % this.SURPRISE_BUFFER_SIZE;
      result.push(this.recentSurprises[idx]);
    }

    return result;
  }

  async close(): Promise<void> {
    this.memoryCache.clear();
    // Reset circular buffer
    this.recentSurprises = new Float64Array(this.SURPRISE_BUFFER_SIZE);
    this.surpriseIndex = 0;
    this.surpriseCount = 0;
    if (this.vectorStorage) {
      await this.vectorStorage.close();
    }
    this.reranker = null;
    this.initialized = false;
  }
}
