import { AutoConsolidationManager } from '../src/adaptive/auto-consolidation';
import { MemoryEntry } from '../src/types';

function makeMemory(id: string, content: string, layer = 5): MemoryEntry {
  return {
    id,
    content,
    layer,
    timestamp: new Date(),
    metadata: {},
  };
}

describe('AutoConsolidationManager', () => {
  let manager: AutoConsolidationManager;

  beforeEach(() => {
    manager = new AutoConsolidationManager();
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      expect(manager).toBeDefined();
    });

    it('should accept custom config', () => {
      const custom = new AutoConsolidationManager({
        enabled: false,
        similarityThreshold: 0.8,
      });
      expect(custom).toBeDefined();
    });
  });

  describe('checkForConsolidation', () => {
    it('should return empty array when disabled', async () => {
      const disabled = new AutoConsolidationManager({ enabled: false });
      const mem = makeMemory('a', 'hello world');
      const result = await disabled.checkForConsolidation(mem, [makeMemory('b', 'hello world')]);
      expect(result).toEqual([]);
    });

    it('should find candidates for very similar memories', async () => {
      const mem1 = makeMemory('a', 'The quick brown fox jumps over the lazy dog');
      const mem2 = makeMemory('b', 'The quick brown fox jumps over the lazy dog');
      const candidates = await manager.checkForConsolidation(mem1, [mem2]);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].similarity).toBeGreaterThanOrEqual(0.9);
    });

    it('should not find candidates for dissimilar memories', async () => {
      const mem1 = makeMemory('a', 'JavaScript is a programming language');
      const mem2 = makeMemory('b', 'Bananas are a tropical fruit rich in potassium');
      const candidates = await manager.checkForConsolidation(mem1, [mem2]);
      expect(candidates).toEqual([]);
    });

    it('should skip self-comparison', async () => {
      const mem = makeMemory('same-id', 'identical content here');
      const candidates = await manager.checkForConsolidation(mem, [mem]);
      expect(candidates).toEqual([]);
    });

    it('should skip already processed pairs', async () => {
      const mem1 = makeMemory('a', 'The quick brown fox jumps over the lazy dog');
      const mem2 = makeMemory('b', 'The quick brown fox jumps over the lazy dog');
      // First call
      await manager.checkForConsolidation(mem1, [mem2]);
      // Second call — same pair should be skipped
      const secondResult = await manager.checkForConsolidation(mem1, [mem2]);
      expect(secondResult).toEqual([]);
    });

    it('should check multiple recent memories', async () => {
      const newMem = makeMemory('new', 'alpha beta gamma delta epsilon');
      const recent = [
        makeMemory('r1', 'alpha beta gamma delta epsilon'),
        makeMemory('r2', 'completely different content entirely'),
        makeMemory('r3', 'alpha beta gamma delta epsilon zeta'),
      ];
      const candidates = await manager.checkForConsolidation(newMem, recent);
      // At least the exact match should be found
      expect(candidates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('shouldAutoMerge', () => {
    it('should return true for very high similarity', () => {
      const candidate = {
        memory1Id: 'a',
        memory2Id: 'b',
        similarity: 0.98,
        detectedAt: new Date(),
      };
      expect(manager.shouldAutoMerge(candidate)).toBe(true);
    });

    it('should return false for similarity below autoMergeThreshold', () => {
      const candidate = {
        memory1Id: 'a',
        memory2Id: 'b',
        similarity: 0.91,
        detectedAt: new Date(),
      };
      expect(manager.shouldAutoMerge(candidate)).toBe(false);
    });

    it('should return true at exact threshold', () => {
      const candidate = {
        memory1Id: 'a',
        memory2Id: 'b',
        similarity: 0.95,
        detectedAt: new Date(),
      };
      expect(manager.shouldAutoMerge(candidate)).toBe(true);
    });
  });

  describe('canExecuteConsolidation', () => {
    it('should return true initially', () => {
      expect(manager.canExecuteConsolidation()).toBe(true);
    });

    it('should return false immediately after execution', async () => {
      const mem1 = makeMemory('a', 'Content A');
      const mem2 = makeMemory('b', 'Content B');
      await manager.executeConsolidation(mem1, mem2, 0.95);
      expect(manager.canExecuteConsolidation()).toBe(false);
    });

    it('should return true after cooldown', async () => {
      const fast = new AutoConsolidationManager({ cooldownMs: 10 });
      const mem1 = makeMemory('a', 'Content A');
      const mem2 = makeMemory('b', 'Content B');
      await fast.executeConsolidation(mem1, mem2, 0.95);
      await new Promise(r => setTimeout(r, 20));
      expect(fast.canExecuteConsolidation()).toBe(true);
    });
  });

  describe('executeConsolidation', () => {
    it('should return a consolidation result', async () => {
      const mem1 = makeMemory('a', 'The fox is quick. It runs fast.');
      const mem2 = makeMemory('b', 'The fox is quick. It jumps high.');
      const result = await manager.executeConsolidation(mem1, mem2, 0.92);
      expect(result).toHaveProperty('id');
      expect(result.sourceIds).toEqual(['a', 'b']);
      expect(result.mergedContent).toBeTruthy();
      expect(result.similarity).toBe(0.92);
      expect(result.consolidatedAt).toBeInstanceOf(Date);
    });

    it('should mark autoMerged when similarity >= autoMergeThreshold', async () => {
      const mem1 = makeMemory('a', 'Same content');
      const mem2 = makeMemory('b', 'Same content');
      const result = await manager.executeConsolidation(mem1, mem2, 0.96);
      expect(result.autoMerged).toBe(true);
    });

    it('should not mark autoMerged when similarity < autoMergeThreshold', async () => {
      const mem1 = makeMemory('a', 'Content A');
      const mem2 = makeMemory('b', 'Content B');
      const result = await manager.executeConsolidation(mem1, mem2, 0.91);
      expect(result.autoMerged).toBe(false);
    });

    it('should remove candidate from pending after execution', async () => {
      const mem1 = makeMemory('x', 'The quick brown fox jumps over the lazy dog');
      const mem2 = makeMemory('y', 'The quick brown fox jumps over the lazy dog');
      await manager.checkForConsolidation(mem1, [mem2]);
      const stats1 = manager.getStats();
      expect(stats1.pendingCount).toBeGreaterThan(0);
      await manager.executeConsolidation(mem1, mem2, 0.99);
      const stats2 = manager.getStats();
      expect(stats2.pendingCount).toBeLessThan(stats1.pendingCount);
    });

    it('should merge content keeping unique sentences', async () => {
      const mem1 = makeMemory('a', 'Sentence one. Sentence two.');
      const mem2 = makeMemory('b', 'Sentence one. Sentence three.');
      const result = await manager.executeConsolidation(mem1, mem2, 0.95);
      expect(result.mergedContent).toContain('Sentence one');
      expect(result.mergedContent).toContain('Sentence two');
      expect(result.mergedContent).toContain('Sentence three');
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = manager.getStats();
      expect(stats.pendingCount).toBe(0);
      expect(stats.historyCount).toBe(0);
      expect(stats.pendingCount + stats.historyCount).toBe(0);
    });

    it('should track consolidation count', async () => {
      const mem1 = makeMemory('a', 'First content');
      const mem2 = makeMemory('b', 'Second content');
      await manager.executeConsolidation(mem1, mem2, 0.95);
      const stats = manager.getStats();
      expect(stats.historyCount).toBe(1);
    });
  });

  describe('getPendingCandidates', () => {
    it('should return empty array initially', () => {
      expect(manager.getPendingCandidates()).toEqual([]);
    });

    it('should return candidates after detection', async () => {
      const mem1 = makeMemory('a', 'The quick brown fox jumps over the lazy dog');
      const mem2 = makeMemory('b', 'The quick brown fox jumps over the lazy dog');
      await manager.checkForConsolidation(mem1, [mem2]);
      const pending = manager.getPendingCandidates();
      expect(pending.length).toBeGreaterThan(0);
    });
  });

  describe('getHistory', () => {
    it('should return empty array initially', () => {
      expect(manager.getHistory()).toEqual([]);
    });

    it('should include completed consolidations', async () => {
      const mem1 = makeMemory('a', 'Content A');
      const mem2 = makeMemory('b', 'Content B');
      await manager.executeConsolidation(mem1, mem2, 0.95);
      const history = manager.getHistory();
      expect(history).toHaveLength(1);
    });
  });

  describe('maxPendingCandidates enforcement', () => {
    it('should evict oldest when limit exceeded', async () => {
      const small = new AutoConsolidationManager({
        maxPendingCandidates: 2,
        similarityThreshold: 0.0, // Accept all for testing
      });
      // Add 3 pairs to exceed limit of 2
      await small.checkForConsolidation(
        makeMemory('a', 'first content'),
        [makeMemory('b', 'first content match')]
      );
      await small.checkForConsolidation(
        makeMemory('c', 'second content'),
        [makeMemory('d', 'second content match')]
      );
      await small.checkForConsolidation(
        makeMemory('e', 'third content'),
        [makeMemory('f', 'third content match')]
      );
      const pending = small.getPendingCandidates();
      expect(pending.length).toBeLessThanOrEqual(2);
    });
  });
});
