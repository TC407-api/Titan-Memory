/**
 * Extended Utility Module Tests
 * Covers calculateUtilityScore, applyFeedback, getUtilityStats,
 * shouldPruneByUtility, weightByUtility, UtilityTracker, getUtilityTracker
 */

import {
  calculateUtilityScore,
  applyFeedback,
  getUtilityStats,
  shouldPruneByUtility,
  weightByUtility,
  UtilityTracker,
  getUtilityTracker,
} from '../src/utils/utility';
import { MemoryEntry, MemoryLayer, MemoryMetadata } from '../src/types';

function makeEntry(overrides: Partial<MemoryEntry['metadata']> = {}): MemoryEntry {
  return {
    id: 'mem-1',
    content: 'test content',
    timestamp: new Date(),
    layer: MemoryLayer.LONG_TERM,
    metadata: {
      importance: 0.5,
      ...overrides,
    },
  };
}

describe('calculateUtilityScore', () => {
  it('should return 0.5 when no interactions', () => {
    expect(calculateUtilityScore(0, 0)).toBe(0.5);
  });

  it('should return 1.0 when all helpful', () => {
    expect(calculateUtilityScore(10, 0)).toBe(1.0);
  });

  it('should return 0.0 when all harmful', () => {
    expect(calculateUtilityScore(0, 10)).toBe(0.0);
  });

  it('should return 0.5 for equal helpful and harmful', () => {
    expect(calculateUtilityScore(5, 5)).toBe(0.5);
  });

  it('should calculate fractional scores correctly', () => {
    expect(calculateUtilityScore(3, 1)).toBe(0.75);
  });

  it('should calculate low utility for mostly harmful', () => {
    expect(calculateUtilityScore(1, 9)).toBeCloseTo(0.1);
  });
});

describe('applyFeedback', () => {
  it('should increment helpfulCount on helpful signal', () => {
    const metadata = { importance: 0.5 } as MemoryMetadata;
    const result = applyFeedback(metadata, 'helpful');
    expect(result.helpfulCount).toBe(1);
    expect(result.harmfulCount).toBeUndefined();
  });

  it('should increment harmfulCount on harmful signal', () => {
    const metadata = { importance: 0.5 } as MemoryMetadata;
    const result = applyFeedback(metadata, 'harmful');
    expect(result.harmfulCount).toBe(1);
    expect(result.helpfulCount).toBeUndefined();
  });

  it('should accumulate multiple helpful signals', () => {
    let metadata: MemoryMetadata = { importance: 0.5 };
    metadata = applyFeedback(metadata, 'helpful');
    metadata = applyFeedback(metadata, 'helpful');
    expect(metadata.helpfulCount).toBe(2);
  });

  it('should recalculate utilityScore correctly', () => {
    let metadata: MemoryMetadata = { importance: 0.5 };
    metadata = applyFeedback(metadata, 'helpful');
    metadata = applyFeedback(metadata, 'harmful');
    expect(metadata.utilityScore).toBe(0.5);
  });

  it('should set lastHelpful timestamp on helpful signal', () => {
    const metadata = { importance: 0.5 } as MemoryMetadata;
    const result = applyFeedback(metadata, 'helpful');
    expect(result.lastHelpful).toBeDefined();
    expect(new Date(result.lastHelpful!).getTime()).toBeGreaterThan(0);
  });

  it('should set lastHarmful timestamp on harmful signal', () => {
    const metadata = { importance: 0.5 } as MemoryMetadata;
    const result = applyFeedback(metadata, 'harmful');
    expect(result.lastHarmful).toBeDefined();
  });

  it('should not mutate the original metadata', () => {
    const metadata = { importance: 0.5 } as MemoryMetadata;
    applyFeedback(metadata, 'helpful');
    expect((metadata as any).helpfulCount).toBeUndefined();
  });
});

describe('getUtilityStats', () => {
  it('should return neutral stats for empty metadata', () => {
    const stats = getUtilityStats({ importance: 0.5 } as MemoryMetadata);
    expect(stats.helpfulCount).toBe(0);
    expect(stats.harmfulCount).toBe(0);
    expect(stats.utilityScore).toBe(0.5);
    expect(stats.lastHelpful).toBeUndefined();
    expect(stats.lastHarmful).toBeUndefined();
  });

  it('should parse lastHelpful as a Date', () => {
    const iso = new Date().toISOString();
    const stats = getUtilityStats({ importance: 0.5, lastHelpful: iso, helpfulCount: 1 });
    expect(stats.lastHelpful).toBeInstanceOf(Date);
  });

  it('should parse lastHarmful as a Date', () => {
    const iso = new Date().toISOString();
    const stats = getUtilityStats({ importance: 0.5, lastHarmful: iso, harmfulCount: 1 });
    expect(stats.lastHarmful).toBeInstanceOf(Date);
  });

  it('should reflect counts from metadata', () => {
    const stats = getUtilityStats({ importance: 0.5, helpfulCount: 3, harmfulCount: 1 });
    expect(stats.helpfulCount).toBe(3);
    expect(stats.harmfulCount).toBe(1);
    expect(stats.utilityScore).toBe(0.75);
  });
});

describe('shouldPruneByUtility', () => {
  it('should NOT prune memories with no feedback (cold start protection)', () => {
    expect(shouldPruneByUtility({ importance: 0.5 } as MemoryMetadata)).toBe(false);
  });

  it('should prune when utility score is below threshold', () => {
    const meta: MemoryMetadata = { importance: 0.5, helpfulCount: 1, harmfulCount: 9 };
    expect(shouldPruneByUtility(meta)).toBe(true);
  });

  it('should NOT prune when utility score is above threshold', () => {
    const meta: MemoryMetadata = { importance: 0.5, helpfulCount: 9, harmfulCount: 1 };
    expect(shouldPruneByUtility(meta)).toBe(false);
  });

  it('should respect custom utilityThreshold', () => {
    const meta: MemoryMetadata = { importance: 0.5, helpfulCount: 5, harmfulCount: 5 };
    expect(shouldPruneByUtility(meta, 0.6)).toBe(true);
    expect(shouldPruneByUtility(meta, 0.4)).toBe(false);
  });

  it('should prune at exactly below the threshold boundary', () => {
    // utilityScore = 3/10 = 0.3 < 0.4 default
    const meta: MemoryMetadata = { importance: 0.5, helpfulCount: 3, harmfulCount: 7 };
    expect(shouldPruneByUtility(meta, 0.4)).toBe(true);
  });

  it('should NOT prune at exactly the threshold', () => {
    // utilityScore = 4/10 = 0.4, not < 0.4
    const meta: MemoryMetadata = { importance: 0.5, helpfulCount: 4, harmfulCount: 6 };
    expect(shouldPruneByUtility(meta, 0.4)).toBe(false);
  });
});

describe('weightByUtility', () => {
  it('should return empty array for empty input', () => {
    expect(weightByUtility([], [])).toEqual([]);
  });

  it('should weight helpful memories higher than harmful ones', () => {
    const helpful = makeEntry({ utilityScore: 1.0 });
    const harmful = makeEntry({ utilityScore: 0.0 });
    helpful.id = 'helpful';
    harmful.id = 'harmful';
    const results = weightByUtility([helpful, harmful], [1.0, 1.0]);
    expect(results[0].weightedScore).toBeGreaterThan(results[1].weightedScore);
  });

  it('should use default neutral weight 0.5 for missing utilityScore', () => {
    const entry = makeEntry({});
    const results = weightByUtility([entry], [1.0]);
    // neutralWeight = 0.7 + 0.5 * 0.6 = 1.0
    expect(results[0].weightedScore).toBeCloseTo(1.0);
  });

  it('should apply base score multiplication', () => {
    const entry = makeEntry({ utilityScore: 0.5 });
    const resultsHigh = weightByUtility([entry], [2.0]);
    const resultsLow = weightByUtility([entry], [1.0]);
    expect(resultsHigh[0].weightedScore).toBeGreaterThan(resultsLow[0].weightedScore);
  });

  it('should preserve memory reference in output', () => {
    const entry = makeEntry({ utilityScore: 0.8 });
    const results = weightByUtility([entry], [1.0]);
    expect(results[0].memory).toBe(entry);
  });
});

describe('UtilityTracker', () => {
  let tracker: UtilityTracker;

  beforeEach(() => {
    tracker = new UtilityTracker();
  });

  describe('recordFeedback', () => {
    it('should record helpful feedback and return true', () => {
      const result = tracker.recordFeedback('mem-1', 'helpful');
      expect(result).toBe(true);
    });

    it('should record harmful feedback and return true', () => {
      const result = tracker.recordFeedback('mem-1', 'harmful');
      expect(result).toBe(true);
    });

    it('should return false for duplicate feedback in same session', () => {
      tracker.recordFeedback('mem-1', 'helpful', 'session-1');
      const duplicate = tracker.recordFeedback('mem-1', 'helpful', 'session-1');
      expect(duplicate).toBe(false);
    });

    it('should allow different signals for same memory in same session', () => {
      tracker.recordFeedback('mem-1', 'helpful', 'session-1');
      const result = tracker.recordFeedback('mem-1', 'harmful', 'session-1');
      expect(result).toBe(true);
    });

    it('should allow same signal across different sessions', () => {
      tracker.recordFeedback('mem-1', 'helpful', 'session-1');
      const result = tracker.recordFeedback('mem-1', 'helpful', 'session-2');
      expect(result).toBe(true);
    });

    it('should record without sessionId (no dedup)', () => {
      tracker.recordFeedback('mem-1', 'helpful');
      const result = tracker.recordFeedback('mem-1', 'helpful');
      expect(result).toBe(true);
    });
  });

  describe('getFeedbackHistory', () => {
    it('should return empty array for unknown memory', () => {
      expect(tracker.getFeedbackHistory('unknown')).toEqual([]);
    });

    it('should return records for a known memory', () => {
      tracker.recordFeedback('mem-1', 'helpful', undefined, 'ctx');
      const history = tracker.getFeedbackHistory('mem-1');
      expect(history).toHaveLength(1);
      expect(history[0].signal).toBe('helpful');
      expect(history[0].memoryId).toBe('mem-1');
    });

    it('should only return records for the specified memory', () => {
      tracker.recordFeedback('mem-1', 'helpful');
      tracker.recordFeedback('mem-2', 'harmful');
      expect(tracker.getFeedbackHistory('mem-1')).toHaveLength(1);
    });
  });

  describe('getFeedbackSince', () => {
    it('should return records after the given timestamp', () => {
      const past = new Date(Date.now() - 10000);
      tracker.recordFeedback('mem-1', 'helpful');
      const results = tracker.getFeedbackSince(past);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty for future timestamp', () => {
      tracker.recordFeedback('mem-1', 'helpful');
      const future = new Date(Date.now() + 10000);
      expect(tracker.getFeedbackSince(future)).toHaveLength(0);
    });
  });

  describe('clearSession', () => {
    it('should allow re-recording after session clear', () => {
      tracker.recordFeedback('mem-1', 'helpful', 'session-1');
      tracker.clearSession('session-1');
      const result = tracker.recordFeedback('mem-1', 'helpful', 'session-1');
      expect(result).toBe(true);
    });

    it('should not throw when clearing non-existent session', () => {
      expect(() => tracker.clearSession('non-existent')).not.toThrow();
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty tracker', () => {
      const stats = tracker.getStats();
      expect(stats.totalFeedback).toBe(0);
      expect(stats.helpfulCount).toBe(0);
      expect(stats.harmfulCount).toBe(0);
      expect(stats.uniqueMemories).toBe(0);
      expect(stats.activeSessions).toBe(0);
    });

    it('should count helpful and harmful separately', () => {
      tracker.recordFeedback('mem-1', 'helpful');
      tracker.recordFeedback('mem-2', 'harmful');
      const stats = tracker.getStats();
      expect(stats.helpfulCount).toBe(1);
      expect(stats.harmfulCount).toBe(1);
      expect(stats.totalFeedback).toBe(2);
    });

    it('should count unique memories', () => {
      tracker.recordFeedback('mem-1', 'helpful');
      tracker.recordFeedback('mem-1', 'harmful');
      tracker.recordFeedback('mem-2', 'helpful');
      const stats = tracker.getStats();
      expect(stats.uniqueMemories).toBe(2);
    });

    it('should count active sessions', () => {
      tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      tracker.recordFeedback('mem-2', 'harmful', 'session-B');
      const stats = tracker.getStats();
      expect(stats.activeSessions).toBe(2);
    });
  });
});

describe('getUtilityTracker', () => {
  it('should return the same singleton instance on multiple calls', () => {
    const t1 = getUtilityTracker();
    const t2 = getUtilityTracker();
    expect(t1).toBe(t2);
  });

  it('should return an instance of UtilityTracker', () => {
    expect(getUtilityTracker()).toBeInstanceOf(UtilityTracker);
  });
});
