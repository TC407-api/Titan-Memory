/**
 * Cortex Drift Monitor
 * Tracks classification accuracy via utility feedback
 * Documents every "Right" vs "Wrong" (self-healing logic)
 *
 * Enhanced with:
 * - Embedding centroid tracking (cosine distance between windows)
 * - File persistence (entries survive restarts)
 * - SPC-style drift detection
 */

import * as fs from 'fs';
import * as path from 'path';
import { MemoryCategory, DriftEntry, DriftStats, EmbeddingDriftMetrics } from './types.js';

const DEFAULT_ALERT_THRESHOLD = 0.7;
const RECENT_WINDOW = 50;
const EMBEDDING_DRIFT_THRESHOLD = 0.15;
const MAX_PERSISTED_ENTRIES = 2000;

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compute centroid (mean vector) of a set of embeddings
 */
function computeCentroid(embeddings: number[][]): number[] | null {
  if (embeddings.length === 0) return null;
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }
  return centroid;
}

/**
 * Drift Monitor - tracks classification accuracy and embedding drift over time
 */
export class DriftMonitor {
  private entries: DriftEntry[] = [];
  private alertThreshold: number;
  private enabled: boolean;
  private persistPath: string | null;

  constructor(options?: {
    alertThreshold?: number;
    enabled?: boolean;
    persistPath?: string;
  }) {
    this.alertThreshold = options?.alertThreshold ?? DEFAULT_ALERT_THRESHOLD;
    this.enabled = options?.enabled ?? false;
    this.persistPath = options?.persistPath ?? null;

    if (this.persistPath) {
      this.loadFromDisk();
    }
  }

  /**
   * Record a classification outcome based on feedback
   */
  recordFeedback(
    memoryId: string,
    originalCategory: MemoryCategory,
    feedbackSignal: 'helpful' | 'harmful',
    embedding?: number[]
  ): void {
    if (!this.enabled) return;

    const entry: DriftEntry = {
      timestamp: new Date(),
      memoryId,
      originalCategory,
      feedbackSignal,
      isCorrect: feedbackSignal === 'helpful',
      embedding,
    };

    this.entries.push(entry);

    // Bounded growth
    if (this.entries.length > MAX_PERSISTED_ENTRIES) {
      this.entries = this.entries.slice(-MAX_PERSISTED_ENTRIES);
    }

    this.persistToDisk();
  }

  /**
   * Get drift statistics including embedding drift
   */
  getStats(): DriftStats {
    if (this.entries.length === 0) {
      return this.emptyStats();
    }

    const total = this.entries.length;
    const correct = this.entries.filter(e => e.isCorrect).length;
    const accuracy = correct / total;
    const byCategoryAccuracy = this.calculateCategoryAccuracy();
    const recentTrend = this.calculateTrend();
    const embeddingDrift = this.calculateEmbeddingDrift();

    return {
      totalClassifications: total,
      correctClassifications: correct,
      accuracy,
      byCategoryAccuracy,
      recentTrend,
      alertThreshold: this.alertThreshold,
      belowThreshold: accuracy < this.alertThreshold,
      embeddingDrift,
    };
  }

  /**
   * Check if any alert is triggered (accuracy OR embedding drift)
   */
  isAlertTriggered(): boolean {
    if (this.entries.length < 10) return false;
    const stats = this.getStats();
    if (stats.belowThreshold) return true;
    if (stats.embeddingDrift?.driftDetected) return true;
    return false;
  }

  /**
   * Get entries for a specific category
   */
  getEntriesForCategory(category: MemoryCategory): DriftEntry[] {
    return this.entries.filter(e => e.originalCategory === category);
  }

  /**
   * Get recent entries
   */
  getRecentEntries(count?: number): DriftEntry[] {
    const n = count ?? RECENT_WINDOW;
    return this.entries.slice(-n);
  }

  /**
   * Clear all entries (for testing or reset)
   */
  clear(): void {
    this.entries = [];
    this.persistToDisk();
  }

  /**
   * Check if monitor is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Calculate embedding drift between recent and historical windows
   */
  private calculateEmbeddingDrift(): EmbeddingDriftMetrics | undefined {
    const withEmbeddings = this.entries.filter(e => e.embedding && e.embedding.length > 0);
    if (withEmbeddings.length < RECENT_WINDOW * 2) return undefined;

    const recentEmbeddings = withEmbeddings
      .slice(-RECENT_WINDOW)
      .map(e => e.embedding!);
    const historicalEmbeddings = withEmbeddings
      .slice(-RECENT_WINDOW * 2, -RECENT_WINDOW)
      .map(e => e.embedding!);

    const recentCentroid = computeCentroid(recentEmbeddings);
    const historicalCentroid = computeCentroid(historicalEmbeddings);

    if (!recentCentroid || !historicalCentroid) return undefined;

    const similarity = cosineSimilarity(recentCentroid, historicalCentroid);
    const distance = 1 - similarity;

    return {
      centroidDistance: distance,
      recentCentroid,
      historicalCentroid,
      sampleCount: withEmbeddings.length,
      driftDetected: distance > EMBEDDING_DRIFT_THRESHOLD,
    };
  }

  private calculateCategoryAccuracy(): Record<MemoryCategory, { correct: number; total: number; accuracy: number }> {
    const categories: MemoryCategory[] = ['knowledge', 'profile', 'event', 'behavior', 'skill'];
    const result = {} as Record<MemoryCategory, { correct: number; total: number; accuracy: number }>;

    for (const cat of categories) {
      const catEntries = this.entries.filter(e => e.originalCategory === cat);
      const catCorrect = catEntries.filter(e => e.isCorrect).length;
      const catTotal = catEntries.length;

      result[cat] = {
        correct: catCorrect,
        total: catTotal,
        accuracy: catTotal > 0 ? catCorrect / catTotal : 1,
      };
    }

    return result;
  }

  private calculateTrend(): 'improving' | 'stable' | 'degrading' {
    if (this.entries.length < RECENT_WINDOW * 2) return 'stable';

    const recentEntries = this.entries.slice(-RECENT_WINDOW);
    const previousEntries = this.entries.slice(-RECENT_WINDOW * 2, -RECENT_WINDOW);

    const recentAccuracy = recentEntries.filter(e => e.isCorrect).length / recentEntries.length;
    const previousAccuracy = previousEntries.filter(e => e.isCorrect).length / previousEntries.length;

    const diff = recentAccuracy - previousAccuracy;

    if (diff > 0.05) return 'improving';
    if (diff < -0.05) return 'degrading';
    return 'stable';
  }

  private emptyStats(): DriftStats {
    const emptyCategory = { correct: 0, total: 0, accuracy: 1 };
    return {
      totalClassifications: 0,
      correctClassifications: 0,
      accuracy: 1,
      byCategoryAccuracy: {
        knowledge: { ...emptyCategory },
        profile: { ...emptyCategory },
        event: { ...emptyCategory },
        behavior: { ...emptyCategory },
        skill: { ...emptyCategory },
      },
      recentTrend: 'stable',
      alertThreshold: this.alertThreshold,
      belowThreshold: false,
    };
  }

  private persistToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Strip embeddings from persisted entries to save space
      const stripped = this.entries.map(({ embedding, ...rest }) => rest);
      fs.writeFileSync(this.persistPath, JSON.stringify(stripped, null, 2), 'utf-8');
    } catch {
      // Silent fail — persistence is best-effort
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw) as DriftEntry[];
      this.entries = parsed.map(e => ({
        ...e,
        timestamp: new Date(e.timestamp),
      }));
    } catch {
      // Silent fail — start fresh if corrupt
      this.entries = [];
    }
  }
}
