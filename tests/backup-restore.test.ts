/**
 * Tests for backup and restore utilities.
 * Covers export, restore, empty database, and idempotency.
 */

import { exportBackup, restoreFromBackup } from '../src/storage/backup';
import { IVectorStorage } from '../src/storage/vector-storage';
import { MemoryEntry, MemoryLayer } from '../src/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    layer: MemoryLayer.FACTUAL,
    timestamp: new Date('2026-03-28T00:00:00Z'),
    metadata: { source: 'test', tags: ['backup'] },
  };
}

function makeMockStorage(): jest.Mocked<IVectorStorage> {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    isHybridSearchEnabled: jest.fn().mockReturnValue(false),
    get: jest.fn().mockResolvedValue(null),
    getRecent: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(true),
    count: jest.fn().mockResolvedValue(0),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-backup-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exportBackup', () => {
  test('exports memories to JSON with manifest', async () => {
    const memories = [
      makeEntry('b1', 'memory one'),
      makeEntry('b2', 'memory two'),
      makeEntry('b3', 'memory three'),
    ];
    const outputPath = path.join(tmpDir, 'backup.json');

    const manifest = await exportBackup(() => Promise.resolve(memories as any[]), outputPath);

    expect(manifest.version).toBe('1.0');
    expect(manifest.memoryCount).toBe(3);
    expect(manifest.timestamp).toBeDefined();

    // Verify file was written
    const raw = fs.readFileSync(outputPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.version).toBe('1.0');
    expect(data.memories).toHaveLength(3);
    expect(data.memories[0].id).toBe('b1');
  });

  test('exports empty database backup', async () => {
    const outputPath = path.join(tmpDir, 'empty-backup.json');

    const manifest = await exportBackup(() => Promise.resolve([]), outputPath);

    expect(manifest.memoryCount).toBe(0);
    const data = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(data.memories).toHaveLength(0);
  });
});

describe('restoreFromBackup', () => {
  test('restores memories from backup JSON', async () => {
    const backupPath = path.join(tmpDir, 'restore.json');
    const memories = [
      makeEntry('r1', 'restore one'),
      makeEntry('r2', 'restore two'),
    ];

    // Write backup file
    await exportBackup(() => Promise.resolve(memories as any[]), backupPath);

    // Restore into mock storage
    const storage = makeMockStorage();
    const result = await restoreFromBackup(backupPath, storage);

    expect(result.restoredCount).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(storage.insert).toHaveBeenCalledTimes(2);
  });

  test('restore is idempotent (re-inserting same data)', async () => {
    const backupPath = path.join(tmpDir, 'idempotent.json');
    const memories = [makeEntry('i1', 'idempotent')];

    await exportBackup(() => Promise.resolve(memories as any[]), backupPath);

    const storage = makeMockStorage();

    // Restore twice
    const result1 = await restoreFromBackup(backupPath, storage);
    const result2 = await restoreFromBackup(backupPath, storage);

    expect(result1.restoredCount).toBe(1);
    expect(result2.restoredCount).toBe(1);
    expect(storage.insert).toHaveBeenCalledTimes(2);
  });

  test('handles insert errors gracefully', async () => {
    const backupPath = path.join(tmpDir, 'error.json');
    const memories = [
      makeEntry('e1', 'good'),
      makeEntry('e2', 'bad'),
      makeEntry('e3', 'good too'),
    ];

    await exportBackup(() => Promise.resolve(memories as any[]), backupPath);

    const storage = makeMockStorage();
    storage.insert
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce(undefined);

    const result = await restoreFromBackup(backupPath, storage);

    expect(result.restoredCount).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('e2');
  });

  test('throws on missing backup file', async () => {
    const storage = makeMockStorage();
    await expect(
      restoreFromBackup(path.join(tmpDir, 'nonexistent.json'), storage)
    ).rejects.toThrow();
  });
});
