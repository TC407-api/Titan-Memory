/**
 * Tests for src/learning/cross-project.ts
 * Covers assessApplicability, CrossProjectLearningManager, and
 * createCrossProjectLearningManager.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  assessApplicability,
  CrossProjectLearningManager,
  createCrossProjectLearningManager,
} from '../src/learning/cross-project';
import { PatternLifecycle, TransferablePattern, UpdateRecord } from '../src/types';

// ---------------------------------------------------------------------------
// Mock getConfig so disk paths point to a temp dir per test
// ---------------------------------------------------------------------------

let tempDir: string;

jest.mock('../src/utils/config', () => ({
  getConfig: () => ({ dataDir: tempDir }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUpdateRecord(content: string): UpdateRecord {
  return {
    timestamp: new Date(),
    changeType: 'create',
    newContent: content,
  };
}

function makePattern(overrides: Partial<PatternLifecycle> = {}): PatternLifecycle {
  return {
    id: `pat-${Math.random().toString(36).slice(2)}`,
    memoryId: 'mem-1',
    stage: 'stable',
    createdAt: new Date(),
    maturityScore: 0.8,
    plasticityIndex: 0.3,
    stabilityIndex: 0.9,
    updateHistory: [makeUpdateRecord('some pattern content about testing architecture')],
    rehearsalCount: 5,
    snapshotContent: 'snapshot',
    snapshotDate: new Date(),
    domain: 'general',
    ...overrides,
  };
}

function makeTransferablePattern(overrides: Partial<TransferablePattern> = {}): TransferablePattern {
  return {
    patternId: `tp-${Math.random().toString(36).slice(2)}`,
    sourceProject: 'project-alpha',
    content: 'use dependency injection for testability',
    applicability: 0.8,
    domain: 'general',
    stage: 'stable',
    transferCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach: isolate each test to its own temp directory
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-cross-project-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// assessApplicability
// ---------------------------------------------------------------------------

describe('assessApplicability', () => {
  it('should return a value between 0 and 1', () => {
    const score = assessApplicability(makePattern());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('should give a higher score to patterns with domain=general', () => {
    const general = makePattern({ domain: 'general', stabilityIndex: 0.5, maturityScore: 0.5 });
    const specific = makePattern({ domain: 'frontend', stabilityIndex: 0.5, maturityScore: 0.5 });
    expect(assessApplicability(general)).toBeGreaterThan(assessApplicability(specific));
  });

  it('should add 0.15 bonus for distilledContent presence', () => {
    const without = makePattern({ domain: 'frontend', stabilityIndex: 0.5, maturityScore: 0.5, distilledContent: undefined });
    const with_ = makePattern({ domain: 'frontend', stabilityIndex: 0.5, maturityScore: 0.5, distilledContent: 'core insight' });
    expect(assessApplicability(with_)).toBeGreaterThan(assessApplicability(without));
  });

  it('should give a slightly higher score for domain-specific vs no domain', () => {
    const withDomain = makePattern({ domain: 'backend', stabilityIndex: 0.5, maturityScore: 0.5, distilledContent: undefined });
    const noDomain = makePattern({ domain: undefined, stabilityIndex: 0.5, maturityScore: 0.5, distilledContent: undefined });
    expect(assessApplicability(withDomain)).toBeGreaterThanOrEqual(assessApplicability(noDomain));
  });

  it('should factor stabilityIndex into the score', () => {
    const lowStability = makePattern({ stabilityIndex: 0.1, maturityScore: 0.5, domain: 'general' });
    const highStability = makePattern({ stabilityIndex: 0.9, maturityScore: 0.5, domain: 'general' });
    expect(assessApplicability(highStability)).toBeGreaterThan(assessApplicability(lowStability));
  });

  it('should factor maturityScore into the score', () => {
    const lowMaturity = makePattern({ stabilityIndex: 0.5, maturityScore: 0.1, domain: 'general' });
    const highMaturity = makePattern({ stabilityIndex: 0.5, maturityScore: 0.9, domain: 'general' });
    expect(assessApplicability(highMaturity)).toBeGreaterThan(assessApplicability(lowMaturity));
  });

  it('should cap the return value at 1.0', () => {
    const maxPattern = makePattern({
      stabilityIndex: 1.0,
      maturityScore: 1.0,
      domain: 'general',
      distilledContent: 'distilled',
    });
    expect(assessApplicability(maxPattern)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// createCrossProjectLearningManager
// ---------------------------------------------------------------------------

describe('createCrossProjectLearningManager', () => {
  it('should return a CrossProjectLearningManager instance', () => {
    const manager = createCrossProjectLearningManager();
    expect(manager).toBeInstanceOf(CrossProjectLearningManager);
  });

  it('should accept optional config', () => {
    const manager = createCrossProjectLearningManager({ enabled: false });
    expect(manager.isEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CrossProjectLearningManager — basic config + init
// ---------------------------------------------------------------------------

describe('CrossProjectLearningManager', () => {
  describe('isEnabled', () => {
    it('should be enabled by default', () => {
      const manager = new CrossProjectLearningManager();
      expect(manager.isEnabled()).toBe(true);
    });

    it('should be disabled when config says enabled: false', () => {
      const manager = new CrossProjectLearningManager({ enabled: false });
      expect(manager.isEnabled()).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should update enabled flag', () => {
      const manager = new CrossProjectLearningManager();
      manager.updateConfig({ enabled: false });
      expect(manager.isEnabled()).toBe(false);
    });
  });

  describe('initialize', () => {
    it('should initialize without error when no data file exists', async () => {
      const manager = new CrossProjectLearningManager();
      await expect(manager.initialize()).resolves.toBeUndefined();
    });

    it('should be idempotent (calling twice does not error)', async () => {
      const manager = new CrossProjectLearningManager();
      await manager.initialize();
      await expect(manager.initialize()).resolves.toBeUndefined();
    });

    it('should load patterns from an existing data file', async () => {
      const dataDir = path.join(tempDir, 'learning');
      fs.mkdirSync(dataDir, { recursive: true });
      const dataPath = path.join(dataDir, 'cross-project.json');
      const stored = makeTransferablePattern({ patternId: 'stored-pat', sourceProject: 'proj-x' });
      fs.writeFileSync(dataPath, JSON.stringify({
        version: '1.0',
        patterns: [stored],
        transferLog: [],
      }));

      const manager = new CrossProjectLearningManager();
      await manager.initialize();
      expect(manager.getPatternsByProject('proj-x').length).toBe(1);
    });

    it('should handle a corrupt data file gracefully', async () => {
      const dataDir = path.join(tempDir, 'learning');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'cross-project.json'), 'not valid json {{');

      const manager = new CrossProjectLearningManager();
      await expect(manager.initialize()).resolves.toBeUndefined();
      expect(manager.getAllPatterns().length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // extractPatterns
  // ---------------------------------------------------------------------------

  describe('extractPatterns', () => {
    it('should return empty array when disabled', async () => {
      const manager = new CrossProjectLearningManager({ enabled: false });
      const result = await manager.extractPatterns('proj-a', [makePattern()]);
      expect(result).toEqual([]);
    });

    it('should skip patterns not in stable or mature stage', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0 });
      const immature = makePattern({ stage: 'immature' });
      const result = await manager.extractPatterns('proj-a', [immature]);
      expect(result).toEqual([]);
    });

    it('should skip patterns with applicability below minApplicability', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.99 });
      const low = makePattern({ stage: 'stable', stabilityIndex: 0.1, maturityScore: 0.1 });
      const result = await manager.extractPatterns('proj-a', [low]);
      expect(result).toEqual([]);
    });

    it('should extract a stable pattern that meets applicability threshold', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.5 });
      const high = makePattern({
        stage: 'stable',
        stabilityIndex: 1.0,
        maturityScore: 1.0,
        domain: 'general',
        distilledContent: 'core insight',
      });
      const result = await manager.extractPatterns('proj-a', [high]);
      expect(result.length).toBe(1);
      expect(result[0].sourceProject).toBe('proj-a');
    });

    it('should extract a mature pattern', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.5 });
      const mature = makePattern({
        stage: 'mature',
        stabilityIndex: 1.0,
        maturityScore: 1.0,
        domain: 'general',
      });
      const result = await manager.extractPatterns('proj-a', [mature]);
      expect(result.length).toBe(1);
    });

    it('should persist extracted patterns to disk', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.5 });
      const high = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      await manager.extractPatterns('proj-a', [high]);

      const dataPath = path.join(tempDir, 'learning', 'cross-project.json');
      expect(fs.existsSync(dataPath)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // findRelevantPatterns
  // ---------------------------------------------------------------------------

  describe('findRelevantPatterns', () => {
    it('should return empty array when disabled', async () => {
      const manager = new CrossProjectLearningManager({ enabled: false });
      const result = await manager.findRelevantPatterns('test query');
      expect(result).toEqual([]);
    });

    it('should return empty array when no patterns are loaded', async () => {
      const manager = new CrossProjectLearningManager();
      const result = await manager.findRelevantPatterns('any query');
      expect(result).toEqual([]);
    });

    it('should exclude patterns from the same target project', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0, minRelevance: 0.0 });
      const high = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      await manager.extractPatterns('proj-a', [high]);

      const results = await manager.findRelevantPatterns('some content', 'proj-a');
      // All patterns come from proj-a, same project → excluded
      expect(results.length).toBe(0);
    });

    it('should include patterns from different projects', async () => {
      const manager = new CrossProjectLearningManager({
        minApplicability: 0.0,
        minRelevance: 0.0,
      });
      const pat = makePattern({
        id: 'p1',
        stage: 'stable',
        stabilityIndex: 1.0,
        maturityScore: 1.0,
        domain: 'general',
        updateHistory: [makeUpdateRecord('dependency injection testing pattern')],
      });
      await manager.extractPatterns('proj-a', [pat]);

      const results = await manager.findRelevantPatterns('dependency injection testing', 'proj-b');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should filter by domain when option is specified', async () => {
      const manager = new CrossProjectLearningManager({
        minApplicability: 0.0,
        minRelevance: 0.0,
      });
      const backendPat = makePattern({
        stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0,
        domain: 'backend',
        updateHistory: [makeUpdateRecord('backend testing pattern')],
      });
      await manager.extractPatterns('proj-a', [backendPat]);

      // Query with domain: 'frontend' should exclude backend patterns
      const results = await manager.findRelevantPatterns('testing pattern', 'proj-b', { domain: 'frontend' });
      // backend domain pattern should be excluded (not frontend, not general)
      expect(results.length).toBe(0);
    });

    it('should respect the limit option', async () => {
      const manager = new CrossProjectLearningManager({
        minApplicability: 0.0,
        minRelevance: 0.0,
      });
      // Insert 5 unique patterns
      for (let i = 0; i < 5; i++) {
        const p = makePattern({
          stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general',
          updateHistory: [makeUpdateRecord(`pattern content ${i} shared keyword`)],
        });
        await manager.extractPatterns(`proj-source-${i}`, [p]);
      }

      const results = await manager.findRelevantPatterns('pattern content shared keyword', 'proj-query', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should return results sorted by relevance descending', async () => {
      const manager = new CrossProjectLearningManager({
        minApplicability: 0.0,
        minRelevance: 0.0,
      });
      const p1 = makePattern({
        stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general',
        updateHistory: [makeUpdateRecord('highly relevant testing dependency injection')],
      });
      const p2 = makePattern({
        stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general',
        updateHistory: [makeUpdateRecord('somewhat related testing')],
      });
      await manager.extractPatterns('src-1', [p1]);
      await manager.extractPatterns('src-2', [p2]);

      const results = await manager.findRelevantPatterns('testing dependency injection', 'proj-b');
      if (results.length >= 2) {
        expect(results[0].relevance).toBeGreaterThanOrEqual(results[1].relevance);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // recordTransfer
  // ---------------------------------------------------------------------------

  describe('recordTransfer', () => {
    it('should return false for an unknown patternId', async () => {
      const manager = new CrossProjectLearningManager();
      const result = await manager.recordTransfer('unknown-id', 'proj-b');
      expect(result).toBe(false);
    });

    it('should return true and increment transferCount for a known pattern', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0 });
      const pat = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      const extracted = await manager.extractPatterns('proj-a', [pat]);

      const patternId = extracted[0].patternId;
      const result = await manager.recordTransfer(patternId, 'proj-b');
      expect(result).toBe(true);

      const patterns = manager.getAllPatterns();
      const found = patterns.find(p => p.patternId === patternId);
      expect(found?.transferCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getPatternsByProject / getPatternsByDomain
  // ---------------------------------------------------------------------------

  describe('getPatternsByProject', () => {
    it('should return only patterns from the specified project', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0 });
      const p1 = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      const p2 = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      await manager.extractPatterns('proj-a', [p1]);
      await manager.extractPatterns('proj-b', [p2]);

      const projAPatterns = manager.getPatternsByProject('proj-a');
      expect(projAPatterns.every(p => p.sourceProject === 'proj-a')).toBe(true);
    });

    it('should return an empty array when no patterns exist for a project', () => {
      const manager = new CrossProjectLearningManager();
      expect(manager.getPatternsByProject('nonexistent')).toEqual([]);
    });
  });

  describe('getPatternsByDomain', () => {
    it('should return patterns matching the domain or general domain', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0 });
      const backend = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'backend' });
      const general = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      await manager.extractPatterns('proj-a', [backend, general]);

      const results = manager.getPatternsByDomain('backend');
      expect(results.length).toBe(2); // backend + general
    });
  });

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('should report zero totals when empty', () => {
      const manager = new CrossProjectLearningManager();
      const stats = manager.getStats();
      expect(stats.totalPatterns).toBe(0);
      expect(stats.totalTransfers).toBe(0);
      expect(stats.avgApplicability).toBe(0);
    });

    it('should count patterns by domain and project', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0 });
      const p1 = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'backend' });
      const p2 = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      await manager.extractPatterns('proj-a', [p1, p2]);

      const stats = manager.getStats();
      expect(stats.totalPatterns).toBe(2);
      expect(stats.byDomain['backend']).toBe(1);
      expect(stats.byDomain['general']).toBe(1);
      expect(stats.byProject['proj-a']).toBe(2);
    });

    it('should compute avgApplicability correctly', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0 });
      const p1 = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      await manager.extractPatterns('proj-a', [p1]);

      const stats = manager.getStats();
      expect(stats.avgApplicability).toBeGreaterThan(0);
      expect(stats.avgApplicability).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // applyDecay
  // ---------------------------------------------------------------------------

  describe('applyDecay', () => {
    it('should return 0 when no patterns are present', async () => {
      const manager = new CrossProjectLearningManager();
      const decayed = await manager.applyDecay();
      expect(decayed).toBe(0);
    });

    it('should not remove recently transferred patterns', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0, decayHalfLifeDays: 180 });
      const p = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      const extracted = await manager.extractPatterns('proj-a', [p]);
      await manager.recordTransfer(extracted[0].patternId, 'proj-b');

      const decayed = await manager.applyDecay();
      expect(decayed).toBe(0);
      expect(manager.getAllPatterns().length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // close
  // ---------------------------------------------------------------------------

  describe('close', () => {
    it('should clear all patterns on close', async () => {
      const manager = new CrossProjectLearningManager({ minApplicability: 0.0 });
      const p = makePattern({ stage: 'stable', stabilityIndex: 1.0, maturityScore: 1.0, domain: 'general' });
      await manager.extractPatterns('proj-a', [p]);
      await manager.close();
      expect(manager.getAllPatterns().length).toBe(0);
    });

    it('should allow re-initialization after close', async () => {
      const manager = new CrossProjectLearningManager();
      await manager.initialize();
      await manager.close();
      await expect(manager.initialize()).resolves.toBeUndefined();
    });
  });
});
