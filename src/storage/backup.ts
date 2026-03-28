/**
 * Backup and Restore for Titan Memory v2.2
 *
 * - exportBackup: dumps all memories to a JSON file
 * - restoreFromBackup: reads a backup JSON and inserts into storage
 */

import * as fs from 'fs';
import { IVectorStorage } from './vector-storage.js';

export interface BackupManifest {
  version: string;
  timestamp: string;
  memoryCount: number;
}

export interface RestoreResult {
  restoredCount: number;
  errorCount: number;
  errors: string[];
}

export interface BackupEntry {
  id: string;
  content: string;
  layer?: number;
  timestamp?: string | Date;
  metadata?: Record<string, unknown>;
}

interface BackupFile {
  version: string;
  timestamp: string;
  memoryCount: number;
  memories: BackupEntry[];
}

/**
 * Export all memories to a JSON backup file.
 *
 * @param getMemories - async function returning all memory entries
 * @param outputPath - file path for the JSON backup
 * @returns manifest with version, timestamp, and count
 */
export async function exportBackup(
  getMemories: () => Promise<BackupEntry[]>,
  outputPath: string
): Promise<BackupManifest> {
  const memories = await getMemories();
  const timestamp = new Date().toISOString();

  const backup: BackupFile = {
    version: '1.0',
    timestamp,
    memoryCount: memories.length,
    memories,
  };

  fs.writeFileSync(outputPath, JSON.stringify(backup, null, 2), 'utf-8');

  return {
    version: '1.0',
    timestamp,
    memoryCount: memories.length,
  };
}

/**
 * Restore memories from a JSON backup file into storage.
 *
 * @param backupPath - path to the backup JSON file
 * @param storage - IVectorStorage to insert memories into
 * @returns result with counts and any errors
 */
export async function restoreFromBackup(
  backupPath: string,
  storage: IVectorStorage
): Promise<RestoreResult> {
  const raw = fs.readFileSync(backupPath, 'utf-8');
  const backup: BackupFile = JSON.parse(raw);

  let restoredCount = 0;
  const errors: string[] = [];

  for (const mem of backup.memories) {
    try {
      await storage.insert({
        id: mem.id,
        content: mem.content,
        layer: mem.layer ?? 2,
        timestamp: mem.timestamp ? new Date(mem.timestamp) : new Date(),
        metadata: mem.metadata ?? {},
      } as Parameters<IVectorStorage['insert']>[0]);
      restoredCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${mem.id}: ${msg}`);
    }
  }

  return {
    restoredCount,
    errorCount: errors.length,
    errors,
  };
}
