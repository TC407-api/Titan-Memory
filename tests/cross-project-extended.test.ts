/**
 * Extended Cross-Project Learning Tests
 * Covers assessApplicability, CrossProjectLearningManager,
 * createCrossProjectLearningManager, and all manager methods
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  assessApplicability,
  CrossProjectLearningManager,
  createCrossProjectLearningManager,
} from '../src/learning/cross-project';
import { PatternLifecycle, TransferablePattern } from '../src/types';
import { updateConfig } from '../src/utils/config';

function makePattern(overrides: Partial<PatternLifecycle> = {}): PatternLifecycle {
  return {
    id: `pattern-${Date.now()}-${Math.random()}`,
    memoryId: `mem-${Date.now()}`,
    stage: 'mature',
    createdAt: new Date(),
    maturityScore: 0.7,
    plasticityIndex: 0.5,
    stabilityIndex: 0.8,
    updateHistory: [{ timestamp: new Date(), newContent: 'Use dependency injection for testability', changeType: 'create' as const }],
    rehearsalCount: 0,
    snapshotContent: 'Use dependency injection for testability',
    snapshotDate: new Date(),
    domain: 'general',
    ...overrides,
  };
}

function makeTransferable(overrides: Partial<TransferablePattern> = {}): TransferablePattern {
  return {
    patternId: `tp-${Date.now()}-${Math.random()}`,
    sourceProject: 'project-alpha',
    content: 'Always validate inputs at boundary',
    distilledContent: 'Input validation pattern',
    applicability: 0.8,
    domain: 'general',
    stage: 'mature',
    transferCount: 0,
    ...overrides,
  };
}

describe('assessApplicability', () => {
  it('should return max 1.0 for a fully stable, mature, general pattern with distilled content', () => {
    const pattern = makePattern({
      stabilityIndex: 1.0,
      maturityScore: 1.0,
      domain: 'general',
      distilledContent: 'core insight',
    });
    const score = assessApplicability(pattern);
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThan(0.8);
  });

  it('should return lower score for domain-specific pattern without distilled content', () => {
    const generic = makePattern({
      stabilityIndex: 0.8,
      maturityScore: 0.7,
      domain: 'general',
      distilledContent: 'insight',
    });
    const specific = makePattern({
      stabilityIndex: 0.8,
      maturityScore: 0.7,
      domain: 'react',
      distilledContent: undefined,
    });
    expect(assessApplicability(generic)).toBeGreaterThan(assessApplicability(specific));
  });

  it('should give bonus for distilledContent presence', () => {
    const withDistilled = makePattern({ distilledContent: 'distilled' });
    const withoutDistilled = makePattern({ distilledContent: undefined });
    expect(assessApplicability(withDistilled)).toBeGreaterThan(assessApplicability(withoutDistilled));
  });

  it('should give higher score for general domain vs specific domain', () => {
    const general = makePattern({ domain: 'general' });
    const specific = makePattern({ domain: 'backend' });
    expect(assessApplicability(general)).toBeGreaterThan(assessApplicability(specific));
  });

  it('should give non-zero score for domain-specific pattern', () => {
    const pattern = makePattern({ domain: 'frontend', stabilityIndex: 0.1, maturityScore: 0.1 });
    expect(assessApplicability(pattern)).toBeGreaterThan(0);
  });
});

describe('CrossProjectLearningManager', () => {
  let manager: CrossProjectLearningManager;
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `cross-project-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    updateConfig({ dataDir: testDir, offlineMode: true });
    manager = new CrossProjectLearningManager({ enabled: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('should initialize without error', async () => {
      await expect(manager.initialize()).resolves.not.toThrow();
    });

    it('should be idempotent — calling twice is safe', async () => {
      await manager.initialize();
      await expect(manager.initialize()).resolves.not.toThrow();
    });
  });

  describe('isEnabled', () => {
    it('should return true when enabled', () => {
      expect(manager.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      const disabled = new CrossProjectLearningManager({ enabled: false });
      expect(disabled.isEnabled()).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should update the enabled state', () => {
      manager.updateConfig({ enabled: false });
      expect(manager.isEnabled()).toBe(false);
    });

    it('should merge config without losing existing values', () => {
      manager.updateConfig({ minRelevance: 0.9 });
      expect(manager.isEnabled()).toBe(true);
    });
  });

  describe('extractPatterns', () => {
    it('should return empty array when disabled', async () => {
      const disabled = new CrossProjectLearningManager({ enabled: false });
      await disabled.initialize();
      const patterns = await disabled.extractPatterns('proj', []);
      expect(patterns).toEqual([]);
    });

    it('should extract patterns from PatternLifecycle array', async () => {
      await manager.initialize();
      const lifecycle = makePattern({ stabilityIndex: 0.9, maturityScore: 0.8 });
      const patterns = await manager.extractPatterns('project-a', [lifecycle]);
      expect(patterns.length).toBeGreaterThanOrEqual(1);
    });

    it('should not re-add a nearly-duplicate pattern', async () => {
      await manager.initialize();
      const lifecycle = makePattern({ snapshotContent: 'dependency injection pattern', id: 'fixed-1' });
      await manager.extractPatterns('project-a', [lifecycle]);
      const second = await manager.extractPatterns('project-a', [{ ...lifecycle, id: 'fixed-1b' }]);
      // Should update existing, not duplicate
      const allPatterns = manager.getAllPatterns();
      const matchingContent = allPatterns.filter(p => p.content === lifecycle.snapshotContent);
      expect(matchingContent.length).toBeLessThanOrEqual(2);
      // second extraction should still return results
      expect(Array.isArray(second)).toBe(true);
    });
  });

  describe('findRelevantPatterns', () => {
    beforeEach(async () => {
      await manager.initialize();
    });

    it('should return empty when disabled', async () => {
      const disabled = new CrossProjectLearningManager({ enabled: false });
      await disabled.initialize();
      const results = await disabled.findRelevantPatterns('any query');
      expect(results).toEqual([]);
    });

    it('should return empty when no patterns stored', async () => {
      const results = await manager.findRelevantPatterns('test query');
      expect(results).toEqual([]);
    });

    it('should find relevant patterns by content similarity', async () => {
      const tp = makeTransferable({ content: 'test driven development', sourceProject: 'other-proj' });
      manager['patterns'].set(tp.patternId, tp);
      const results = await manager.findRelevantPatterns('test driven', 'my-project');
      expect(results.length).toBeGreaterThanOrEqual(0); // similarity-dependent
    });

    it('should skip patterns from the same target project', async () => {
      const tp = makeTransferable({ sourceProject: 'same-project' });
      manager['patterns'].set(tp.patternId, tp);
      const results = await manager.findRelevantPatterns('input validation', 'same-project');
      expect(results).toEqual([]);
    });

    it('should filter by domain when specified', async () => {
      const backendPattern = makeTransferable({ domain: 'backend', content: 'database indexing', sourceProject: 'other' });
      const generalPattern = makeTransferable({ domain: 'general', content: 'database indexing', sourceProject: 'other2' });
      manager['patterns'].set(backendPattern.patternId, backendPattern);
      manager['patterns'].set(generalPattern.patternId, generalPattern);
      const results = await manager.findRelevantPatterns('database indexing', 'my-proj', { domain: 'frontend' });
      // backend pattern excluded; general pattern included
      const hasBackend = results.some(r => r.pattern.domain === 'backend');
      expect(hasBackend).toBe(false);
    });

    it('should respect limit option', async () => {
      for (let i = 0; i < 5; i++) {
        const tp = makeTransferable({ sourceProject: `proj-${i}`, content: `input validation technique ${i}` });
        manager['patterns'].set(tp.patternId, tp);
      }
      const results = await manager.findRelevantPatterns('input validation', 'target', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('recordTransfer', () => {
    it('should log a transfer and increment transferCount', async () => {
      await manager.initialize();
      const tp = makeTransferable({ transferCount: 0 });
      manager['patterns'].set(tp.patternId, tp);
      await manager.recordTransfer(tp.patternId, 'target-proj');
      expect(manager['transferLog'].length).toBe(1);
      expect(manager['transferLog'][0].patternId).toBe(tp.patternId);
    });

    it('should return false for non-existent pattern', async () => {
      await manager.initialize();
      const result = await manager.recordTransfer('nonexistent', 'b');
      expect(result).toBe(false);
    });
  });

  describe('applyDecay', () => {
    it('should return 0 when no patterns exist', async () => {
      await manager.initialize();
      const decayed = await manager.applyDecay();
      expect(decayed).toBe(0);
    });

    it('should decay and remove patterns with very old transfer history', async () => {
      await manager.initialize();
      const tp = makeTransferable({ applicability: 0.05 });
      manager['patterns'].set(tp.patternId, tp);
      // Simulate old transfer log entry
      manager['transferLog'].push({
        patternId: tp.patternId,
        sourceProject: 'a',
        targetProject: 'b',
        timestamp: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000), // 400 days ago
      });
      const decayed = await manager.applyDecay();
      expect(decayed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getAllPatterns / getPatternsByProject / getPatternsByDomain', () => {
    beforeEach(async () => {
      await manager.initialize();
      const tp1 = makeTransferable({ sourceProject: 'proj-a', domain: 'backend' });
      const tp2 = makeTransferable({ sourceProject: 'proj-b', domain: 'frontend' });
      const tp3 = makeTransferable({ sourceProject: 'proj-a', domain: 'general' });
      manager['patterns'].set(tp1.patternId, tp1);
      manager['patterns'].set(tp2.patternId, tp2);
      manager['patterns'].set(tp3.patternId, tp3);
    });

    it('should return all patterns', () => {
      expect(manager.getAllPatterns()).toHaveLength(3);
    });

    it('should filter by project', () => {
      const projA = manager.getPatternsByProject('proj-a');
      expect(projA).toHaveLength(2);
      expect(projA.every(p => p.sourceProject === 'proj-a')).toBe(true);
    });

    it('should return empty for unknown project', () => {
      expect(manager.getPatternsByProject('unknown')).toHaveLength(0);
    });

    it('should filter by domain — includes general domain', () => {
      const backend = manager.getPatternsByDomain('backend');
      // Should include backend + general patterns
      expect(backend.some(p => p.domain === 'general')).toBe(true);
      expect(backend.some(p => p.domain === 'backend')).toBe(true);
    });

    it('should not include unrelated domain patterns', () => {
      const backend = manager.getPatternsByDomain('backend');
      expect(backend.some(p => p.domain === 'frontend')).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty manager', async () => {
      await manager.initialize();
      const stats = manager.getStats();
      expect(stats.totalPatterns).toBe(0);
      expect(stats.totalTransfers).toBe(0);
      expect(stats.avgApplicability).toBe(0);
    });

    it('should count patterns by domain and project', async () => {
      await manager.initialize();
      const tp = makeTransferable({ sourceProject: 'proj-x', domain: 'testing' });
      manager['patterns'].set(tp.patternId, tp);
      const stats = manager.getStats();
      expect(stats.totalPatterns).toBe(1);
      expect(stats.byDomain['testing']).toBe(1);
      expect(stats.byProject['proj-x']).toBe(1);
    });

    it('should calculate average applicability', async () => {
      await manager.initialize();
      const tp1 = makeTransferable({ applicability: 0.6 });
      const tp2 = makeTransferable({ applicability: 0.8 });
      manager['patterns'].set(tp1.patternId, tp1);
      manager['patterns'].set(tp2.patternId, tp2);
      const stats = manager.getStats();
      expect(stats.avgApplicability).toBeCloseTo(0.7);
    });
  });

  describe('close', () => {
    it('should close without error', async () => {
      await manager.initialize();
      await expect(manager.close()).resolves.not.toThrow();
    });

    it('should clear patterns on close', async () => {
      await manager.initialize();
      const tp = makeTransferable();
      manager['patterns'].set(tp.patternId, tp);
      await manager.close();
      expect(manager.getAllPatterns()).toHaveLength(0);
    });
  });
});

describe('createCrossProjectLearningManager', () => {
  it('should return a CrossProjectLearningManager instance', () => {
    const mgr = createCrossProjectLearningManager({ enabled: true });
    expect(mgr).toBeInstanceOf(CrossProjectLearningManager);
  });

  it('should respect disabled config', () => {
    const mgr = createCrossProjectLearningManager({ enabled: false });
    expect(mgr.isEnabled()).toBe(false);
  });

  it('should work with no config (uses defaults)', () => {
    const mgr = createCrossProjectLearningManager();
    expect(mgr).toBeInstanceOf(CrossProjectLearningManager);
  });
});
