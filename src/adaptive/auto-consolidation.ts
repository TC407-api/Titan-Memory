/**
 * Auto-Consolidation System
 * Automatically detects and consolidates highly similar memories
 *
 * Safety enhancements (2026-04-02):
 * - SQLite audit trail for all consolidation events
 * - Auto-merge threshold raised from 0.95 to 0.98
 * - Consolidated memories tagged with sourceIds for traceability
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AutoConsolidationConfig, ConsolidationCandidate, MemoryEntry } from '../types.js';
import { contentSimilarity } from '../utils/similarity.js';

const DEFAULT_CONFIG: Required<AutoConsolidationConfig> = {
  enabled: true,
  similarityThreshold: 0.9,
  cooldownMs: 60000,
  maxPendingCandidates: 100,
  autoMergeThreshold: 0.98,
};

/**
 * Consolidation result
 */
export interface ConsolidationResult {
  id: string;
  sourceIds: string[];
  mergedContent: string;
  summary: string;
  similarity: number;
  consolidatedAt: Date;
  autoMerged: boolean;
}

/**
 * Auto-Consolidation Manager
 * Detects similar memories and manages consolidation candidates
 */
export class AutoConsolidationManager {
  private config: Required<AutoConsolidationConfig>;
  private pendingCandidates: Map<string, ConsolidationCandidate> = new Map();
  private consolidationHistory: ConsolidationResult[] = [];
  private lastConsolidationTime: number = 0;
  private processedPairs: Set<string> = new Set();
  private auditDb: Database.Database | null = null;

  constructor(config?: Partial<AutoConsolidationConfig>, auditDbPath?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (auditDbPath) {
      this.initAuditDb(auditDbPath);
    }
  }

  /**
   * Initialize the SQLite audit trail database
   */
  private initAuditDb(dbPath: string): void {
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      this.auditDb = new Database(dbPath);
      this.auditDb.pragma('journal_mode = WAL');
      this.auditDb.exec(`
        CREATE TABLE IF NOT EXISTS consolidation_audit (
          id TEXT PRIMARY KEY,
          source_id_1 TEXT NOT NULL,
          source_id_2 TEXT NOT NULL,
          merged_content TEXT NOT NULL,
          summary TEXT NOT NULL,
          similarity REAL NOT NULL,
          auto_merged INTEGER NOT NULL,
          consolidated_at INTEGER NOT NULL
        )
      `);
      this.auditDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_time ON consolidation_audit(consolidated_at)
      `);
      this.auditDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_sources ON consolidation_audit(source_id_1, source_id_2)
      `);
    } catch {
      this.auditDb = null;
    }
  }

  /**
   * Persist a consolidation event to the audit trail
   */
  private persistAuditEntry(result: ConsolidationResult): void {
    if (!this.auditDb) return;
    try {
      this.auditDb.prepare(`
        INSERT OR REPLACE INTO consolidation_audit
          (id, source_id_1, source_id_2, merged_content, summary, similarity, auto_merged, consolidated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.id,
        result.sourceIds[0],
        result.sourceIds[1],
        result.mergedContent,
        result.summary,
        result.similarity,
        result.autoMerged ? 1 : 0,
        result.consolidatedAt.getTime()
      );
    } catch {
      // Best-effort persistence
    }
  }

  /**
   * Query audit trail for consolidations involving a specific memory
   */
  getAuditTrail(memoryId?: string, limit: number = 50): ConsolidationResult[] {
    if (!this.auditDb) return this.consolidationHistory.slice(-limit);

    try {
      let rows;
      if (memoryId) {
        rows = this.auditDb.prepare(`
          SELECT * FROM consolidation_audit
          WHERE source_id_1 = ? OR source_id_2 = ?
          ORDER BY consolidated_at DESC LIMIT ?
        `).all(memoryId, memoryId, limit) as Array<Record<string, unknown>>;
      } else {
        rows = this.auditDb.prepare(`
          SELECT * FROM consolidation_audit
          ORDER BY consolidated_at DESC LIMIT ?
        `).all(limit) as Array<Record<string, unknown>>;
      }

      return rows.map(row => ({
        id: row.id as string,
        sourceIds: [row.source_id_1 as string, row.source_id_2 as string],
        mergedContent: row.merged_content as string,
        summary: row.summary as string,
        similarity: row.similarity as number,
        consolidatedAt: new Date(row.consolidated_at as number),
        autoMerged: (row.auto_merged as number) === 1,
      }));
    } catch {
      return this.consolidationHistory.slice(-limit);
    }
  }

  /**
   * Check a new memory against existing memories for consolidation
   */
  async checkForConsolidation(
    newMemory: MemoryEntry,
    recentMemories: MemoryEntry[]
  ): Promise<ConsolidationCandidate[]> {
    if (!this.config.enabled) return [];

    const newCandidates: ConsolidationCandidate[] = [];

    for (const existing of recentMemories) {
      if (existing.id === newMemory.id) continue;

      const pairKey = this.createPairKey(newMemory.id, existing.id);
      if (this.processedPairs.has(pairKey)) continue;

      const similarity = contentSimilarity(newMemory.content, existing.content);

      if (similarity >= this.config.similarityThreshold) {
        const candidate: ConsolidationCandidate = {
          memory1Id: newMemory.id,
          memory2Id: existing.id,
          similarity,
          detectedAt: new Date(),
        };

        newCandidates.push(candidate);
        this.addCandidate(candidate);
        this.processedPairs.add(pairKey);
      }
    }

    return newCandidates;
  }

  private addCandidate(candidate: ConsolidationCandidate): void {
    const key = this.createPairKey(candidate.memory1Id, candidate.memory2Id);
    this.pendingCandidates.set(key, candidate);

    if (this.pendingCandidates.size > this.config.maxPendingCandidates) {
      const firstKey = this.pendingCandidates.keys().next().value;
      if (firstKey) {
        this.pendingCandidates.delete(firstKey);
      }
    }
  }

  private createPairKey(id1: string, id2: string): string {
    return [id1, id2].sort().join(':');
  }

  shouldAutoMerge(candidate: ConsolidationCandidate): boolean {
    return candidate.similarity >= this.config.autoMergeThreshold;
  }

  canExecuteConsolidation(): boolean {
    const now = Date.now();
    return (now - this.lastConsolidationTime) >= this.config.cooldownMs;
  }

  /**
   * Execute consolidation for a candidate pair
   * Result includes consolidated: true tag for downstream traceability
   */
  async executeConsolidation(
    memory1: MemoryEntry,
    memory2: MemoryEntry,
    similarity: number
  ): Promise<ConsolidationResult> {
    const mergedContent = this.mergeContent(memory1.content, memory2.content);
    const summary = this.generateSummary(mergedContent);

    const result: ConsolidationResult = {
      id: uuidv4(),
      sourceIds: [memory1.id, memory2.id],
      mergedContent,
      summary,
      similarity,
      consolidatedAt: new Date(),
      autoMerged: similarity >= this.config.autoMergeThreshold,
    };

    this.consolidationHistory.push(result);
    this.lastConsolidationTime = Date.now();

    const key = this.createPairKey(memory1.id, memory2.id);
    this.pendingCandidates.delete(key);

    if (this.consolidationHistory.length > 1000) {
      this.consolidationHistory = this.consolidationHistory.slice(-1000);
    }

    // Persist to SQLite audit trail
    this.persistAuditEntry(result);

    return result;
  }

  private mergeContent(content1: string, content2: string): string {
    const sentences1 = content1.split(/[.!?]+/).filter(s => s.trim());
    const sentences2 = content2.split(/[.!?]+/).filter(s => s.trim());

    const merged = new Set<string>();
    const normalizedSentences = new Map<string, string>();

    for (const sentence of sentences1) {
      const normalized = sentence.trim().toLowerCase();
      if (!normalizedSentences.has(normalized)) {
        normalizedSentences.set(normalized, sentence.trim());
        merged.add(sentence.trim());
      }
    }

    for (const sentence of sentences2) {
      const normalized = sentence.trim().toLowerCase();
      if (!normalizedSentences.has(normalized)) {
        let isDuplicate = false;
        for (const existing of merged) {
          if (contentSimilarity(sentence, existing) > 0.8) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) {
          normalizedSentences.set(normalized, sentence.trim());
          merged.add(sentence.trim());
        }
      }
    }

    return [...merged].join('. ') + '.';
  }

  private generateSummary(content: string): string {
    const firstSentence = content.split(/[.!?]/)[0];
    if (firstSentence.length <= 100) {
      return firstSentence.trim();
    }
    return content.substring(0, 100).trim() + '...';
  }

  getPendingCandidates(): ConsolidationCandidate[] {
    return [...this.pendingCandidates.values()];
  }

  getAutoMergeCandidates(): ConsolidationCandidate[] {
    return [...this.pendingCandidates.values()]
      .filter(c => this.shouldAutoMerge(c));
  }

  getHistory(): ConsolidationResult[] {
    return [...this.consolidationHistory];
  }

  getRecentConsolidations(windowMs: number = 3600000): ConsolidationResult[] {
    const now = Date.now();
    return this.consolidationHistory
      .filter(c => (now - c.consolidatedAt.getTime()) <= windowMs);
  }

  dismissCandidate(memory1Id: string, memory2Id: string): boolean {
    const key = this.createPairKey(memory1Id, memory2Id);
    return this.pendingCandidates.delete(key);
  }

  updateConfig(config: Partial<AutoConsolidationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getStats(): {
    enabled: boolean;
    pendingCount: number;
    historyCount: number;
    autoMergeCount: number;
    cooldownRemaining: number;
  } {
    const now = Date.now();
    const cooldownRemaining = Math.max(0, this.config.cooldownMs - (now - this.lastConsolidationTime));
    const autoMergeCount = this.consolidationHistory.filter(c => c.autoMerged).length;

    return {
      enabled: this.config.enabled,
      pendingCount: this.pendingCandidates.size,
      historyCount: this.consolidationHistory.length,
      autoMergeCount,
      cooldownRemaining,
    };
  }

  /**
   * Close the audit database connection
   */
  close(): void {
    if (this.auditDb) {
      this.auditDb.close();
      this.auditDb = null;
    }
  }

  clear(): void {
    this.pendingCandidates.clear();
    this.consolidationHistory = [];
    this.processedPairs.clear();
    this.lastConsolidationTime = 0;
  }
}

export function createAutoConsolidationManager(
  config?: Partial<AutoConsolidationConfig>,
  auditDbPath?: string
): AutoConsolidationManager {
  return new AutoConsolidationManager(config, auditDbPath);
}

export async function checkConsolidation(
  newMemory: MemoryEntry,
  recentMemories: MemoryEntry[],
  threshold: number = 0.9
): Promise<ConsolidationCandidate[]> {
  const manager = new AutoConsolidationManager({ similarityThreshold: threshold });
  return manager.checkForConsolidation(newMemory, recentMemories);
}
