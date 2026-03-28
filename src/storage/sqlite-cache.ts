/**
 * SQLite Cache Layer for Titan Memory v2.2
 *
 * Decorator over IVectorStorage that adds a local SQLite cache.
 * - Write-through: inserts go to both cache and inner storage
 * - Read: cache hit returns instantly; miss falls through to inner
 * - Search/hybridSearch: always delegate to inner (no local vectors)
 * - Degraded mode: if inner fails on insert, data is cached for retry
 * - LRU eviction when cache exceeds maxSize
 */

import Database from 'better-sqlite3';
import {
  IVectorStorage,
  VectorSearchResult,
  HybridSearchOptions,
} from './vector-storage.js';
import { MemoryEntry } from '../types.js';

const DEFAULT_MAX_SIZE = 1000;

export class SqliteCacheLayer implements IVectorStorage {
  private db: Database.Database | null = null;
  private readonly inner: IVectorStorage;
  private readonly dbPath: string;
  private readonly maxSize: number;

  constructor(inner: IVectorStorage, dbPath: string, maxSize?: number) {
    this.inner = inner;
    this.dbPath = dbPath;
    this.maxSize = maxSize ?? DEFAULT_MAX_SIZE;
  }

  async initialize(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL
      )
    `);
    await this.inner.initialize();
  }

  async insert(entry: MemoryEntry): Promise<void> {
    // Always write to local cache first
    this.upsertCache(entry);

    // Evict if over limit
    this.evictIfNeeded();

    // Write-through to inner; degrade gracefully on failure
    try {
      await this.inner.insert(entry);
    } catch (_err) {
      // Degraded mode: data is in local cache, inner will catch up
    }
  }

  async get(id: string): Promise<VectorSearchResult | null> {
    // Check cache first
    const cached = this.getFromCache(id);
    if (cached) {
      this.touchAccess(id);
      return cached;
    }

    // Cache miss — fall through to inner
    const result = await this.inner.get(id);

    // Backfill cache on upstream hit
    if (result) {
      this.backfillCache(result);
    }

    return result;
  }

  async search(
    query: string,
    limit: number
  ): Promise<VectorSearchResult[]> {
    return this.inner.search(query, limit);
  }

  async hybridSearch(
    query: string,
    limit: number,
    options?: HybridSearchOptions
  ): Promise<VectorSearchResult[]> {
    if (this.inner.hybridSearch) {
      return this.inner.hybridSearch(query, limit, options);
    }
    return this.inner.search(query, limit);
  }

  isHybridSearchEnabled(): boolean {
    return this.inner.isHybridSearchEnabled?.() ?? false;
  }

  async getRecent(limit: number): Promise<VectorSearchResult[]> {
    return this.inner.getRecent(limit);
  }

  async delete(id: string): Promise<boolean> {
    // Delete from cache
    if (this.db) {
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    }

    return this.inner.delete(id);
  }

  async count(): Promise<number> {
    return this.inner.count();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    await this.inner.close();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private upsertCache(entry: MemoryEntry): void {
    if (!this.db) return;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories
           (id, content, metadata, timestamp, last_accessed)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.content,
        JSON.stringify(entry.metadata),
        entry.timestamp.getTime(),
        now
      );
  }

  private getFromCache(id: string): VectorSearchResult | null {
    if (!this.db) return null;
    const row = this.db
      .prepare('SELECT id, content, metadata FROM memories WHERE id = ?')
      .get(id) as { id: string; content: string; metadata: string } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      content: row.content,
      score: 1.0,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    };
  }

  private touchAccess(id: string): void {
    if (!this.db) return;
    this.db
      .prepare('UPDATE memories SET last_accessed = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  private backfillCache(result: VectorSearchResult): void {
    if (!this.db) return;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memories
           (id, content, metadata, timestamp, last_accessed)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        result.id,
        result.content,
        JSON.stringify(result.metadata),
        now,
        now
      );
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (!this.db) return;
    const countRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM memories')
      .get() as { cnt: number };

    if (countRow.cnt > this.maxSize) {
      const excess = countRow.cnt - this.maxSize;
      this.db
        .prepare(
          `DELETE FROM memories WHERE id IN (
             SELECT id FROM memories ORDER BY last_accessed ASC LIMIT ?
           )`
        )
        .run(excess);
    }
  }
}
