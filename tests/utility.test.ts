/**
 * Tests for src/utils/utility.ts
 * Covers calculateUtilityScore, applyFeedback, getUtilityStats,
 * shouldPruneByUtility, weightByUtility, UtilityTracker, and getUtilityTracker.
 */

import {
  calculateUtilityScore,
  applyFeedback,
  getUtilityStats,
  shouldPruneByUtility,
  weightByUtility,
  UtilityTracker,
} from '../src/utils/utility';
import { MemoryLayer, MemoryMetadata, MemoryEntry } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides: Partial<MemoryMetadata> = {}): MemoryMetadata {
  return { ...overrides };
}

function makeMemoryEntry(id: string, utilityScore?: number): MemoryEntry {
  return {
    id,
    content: `content for ${id}`,
    layer: MemoryLayer.LONG_TERM,
    timestamp: new Date(),
    metadata: makeMetadata({ utilityScore }),
  };
}

// ---------------------------------------------------------------------------
// calculateUtilityScore
// ---------------------------------------------------------------------------

describe('calculateUtilityScore', () => {
  it('should return 0.5 when both counts are zero (neutral/cold-start)', () => {
    expect(calculateUtilityScore(0, 0)).toBe(0.5);
  });

  it('should return 1.0 when only helpful interactions exist', () => {
    expect(calculateUtilityScore(10, 0)).toBe(1.0);
  });

  it('should return 0.0 when only harmful interactions exist', () => {
    expect(calculateUtilityScore(0, 10)).toBe(0.0);
  });

  it('should return 0.5 when helpful and harmful counts are equal', () => {
    expect(calculateUtilityScore(5, 5)).toBe(0.5);
  });

  it('should compute helpful / (helpful + harmful) correctly', () => {
    expect(calculateUtilityScore(3, 1)).toBeCloseTo(0.75);
  });

  it('should return a value between 0 and 1 for any positive counts', () => {
    const score = calculateUtilityScore(7, 3);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('should handle large counts without overflow', () => {
    const score = calculateUtilityScore(1000000, 1000000);
    expect(score).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// applyFeedback
// ---------------------------------------------------------------------------

describe('applyFeedback', () => {
  describe('helpful signal', () => {
    it('should increment helpfulCount from zero', () => {
      const meta = makeMetadata();
      const result = applyFeedback(meta, 'helpful');
      expect(result.helpfulCount).toBe(1);
    });

    it('should increment helpfulCount when already set', () => {
      const meta = makeMetadata({ helpfulCount: 4 });
      const result = applyFeedback(meta, 'helpful');
      expect(result.helpfulCount).toBe(5);
    });

    it('should set lastHelpful to a current ISO timestamp', () => {
      const before = new Date().toISOString();
      const result = applyFeedback(makeMetadata(), 'helpful');
      expect(result.lastHelpful).toBeDefined();
      expect(result.lastHelpful! >= before).toBe(true);
    });

    it('should not modify harmfulCount', () => {
      const meta = makeMetadata({ harmfulCount: 3 });
      const result = applyFeedback(meta, 'helpful');
      expect(result.harmfulCount).toBe(3);
    });

    it('should recompute utilityScore after helpful feedback', () => {
      const meta = makeMetadata({ helpfulCount: 1, harmfulCount: 1 });
      const result = applyFeedback(meta, 'helpful');
      // helpful=2, harmful=1 → 2/3 ≈ 0.667
      expect(result.utilityScore).toBeCloseTo(2 / 3);
    });
  });

  describe('harmful signal', () => {
    it('should increment harmfulCount from zero', () => {
      const meta = makeMetadata();
      const result = applyFeedback(meta, 'harmful');
      expect(result.harmfulCount).toBe(1);
    });

    it('should increment harmfulCount when already set', () => {
      const meta = makeMetadata({ harmfulCount: 2 });
      const result = applyFeedback(meta, 'harmful');
      expect(result.harmfulCount).toBe(3);
    });

    it('should set lastHarmful to a current ISO timestamp', () => {
      const before = new Date().toISOString();
      const result = applyFeedback(makeMetadata(), 'harmful');
      expect(result.lastHarmful).toBeDefined();
      expect(result.lastHarmful! >= before).toBe(true);
    });

    it('should not modify helpfulCount', () => {
      const meta = makeMetadata({ helpfulCount: 5 });
      const result = applyFeedback(meta, 'harmful');
      expect(result.helpfulCount).toBe(5);
    });

    it('should recompute utilityScore after harmful feedback', () => {
      const meta = makeMetadata({ helpfulCount: 1, harmfulCount: 0 });
      const result = applyFeedback(meta, 'harmful');
      // helpful=1, harmful=1 → 0.5
      expect(result.utilityScore).toBeCloseTo(0.5);
    });
  });

  it('should not mutate the original metadata object', () => {
    const meta = makeMetadata({ helpfulCount: 1 });
    applyFeedback(meta, 'helpful');
    expect(meta.helpfulCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getUtilityStats
// ---------------------------------------------------------------------------

describe('getUtilityStats', () => {
  it('should return neutral stats for empty metadata', () => {
    const stats = getUtilityStats(makeMetadata());
    expect(stats.helpfulCount).toBe(0);
    expect(stats.harmfulCount).toBe(0);
    expect(stats.utilityScore).toBe(0.5);
    expect(stats.lastHelpful).toBeUndefined();
    expect(stats.lastHarmful).toBeUndefined();
  });

  it('should parse lastHelpful ISO string into a Date', () => {
    const iso = '2025-01-15T10:00:00.000Z';
    const stats = getUtilityStats(makeMetadata({ lastHelpful: iso }));
    expect(stats.lastHelpful).toBeInstanceOf(Date);
    expect(stats.lastHelpful?.toISOString()).toBe(iso);
  });

  it('should parse lastHarmful ISO string into a Date', () => {
    const iso = '2025-03-01T08:30:00.000Z';
    const stats = getUtilityStats(makeMetadata({ lastHarmful: iso }));
    expect(stats.lastHarmful).toBeInstanceOf(Date);
    expect(stats.lastHarmful?.toISOString()).toBe(iso);
  });

  it('should compute utilityScore from metadata counts', () => {
    const stats = getUtilityStats(makeMetadata({ helpfulCount: 3, harmfulCount: 1 }));
    expect(stats.utilityScore).toBeCloseTo(0.75);
  });
});

// ---------------------------------------------------------------------------
// shouldPruneByUtility
// ---------------------------------------------------------------------------

describe('shouldPruneByUtility', () => {
  it('should return false when there is no feedback (cold-start protection)', () => {
    expect(shouldPruneByUtility(makeMetadata())).toBe(false);
  });

  it('should return false when utility score is above the default threshold', () => {
    // helpful=8, harmful=2 → 0.8, well above 0.4
    const meta = makeMetadata({ helpfulCount: 8, harmfulCount: 2 });
    expect(shouldPruneByUtility(meta)).toBe(false);
  });

  it('should return true when utility score is below the default threshold (0.4)', () => {
    // helpful=1, harmful=9 → 0.1
    const meta = makeMetadata({ helpfulCount: 1, harmfulCount: 9 });
    expect(shouldPruneByUtility(meta)).toBe(true);
  });

  it('should use the provided custom threshold', () => {
    // helpful=5, harmful=5 → 0.5; custom threshold 0.6 → prune
    const meta = makeMetadata({ helpfulCount: 5, harmfulCount: 5 });
    expect(shouldPruneByUtility(meta, 0.6)).toBe(true);
  });

  it('should return false at exactly the threshold (strict less-than)', () => {
    // helpful=2, harmful=3 → 0.4; default threshold 0.4 → NOT below → false
    const meta = makeMetadata({ helpfulCount: 2, harmfulCount: 3 });
    expect(shouldPruneByUtility(meta, 0.4)).toBe(false);
  });

  it('should return true when all interactions are harmful', () => {
    const meta = makeMetadata({ helpfulCount: 0, harmfulCount: 5 });
    expect(shouldPruneByUtility(meta)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// weightByUtility
// ---------------------------------------------------------------------------

describe('weightByUtility', () => {
  it('should return an array of the same length as input', () => {
    const memories = [makeMemoryEntry('a'), makeMemoryEntry('b')];
    const result = weightByUtility(memories, [1.0, 1.0]);
    expect(result.length).toBe(2);
  });

  it('should apply a neutral weight (1.0x) when utilityScore is 0.5', () => {
    // weight = 0.7 + (0.5 * 0.6) = 1.0
    const memory = makeMemoryEntry('a', 0.5);
    const [{ weightedScore }] = weightByUtility([memory], [2.0]);
    expect(weightedScore).toBeCloseTo(2.0);
  });

  it('should boost score when utilityScore is 1.0 (fully helpful)', () => {
    // weight = 0.7 + (1.0 * 0.6) = 1.3
    const memory = makeMemoryEntry('a', 1.0);
    const [{ weightedScore }] = weightByUtility([memory], [1.0]);
    expect(weightedScore).toBeCloseTo(1.3);
  });

  it('should penalise score when utilityScore is 0.0 (fully harmful)', () => {
    // weight = 0.7 + (0.0 * 0.6) = 0.7
    const memory = makeMemoryEntry('a', 0.0);
    const [{ weightedScore }] = weightByUtility([memory], [1.0]);
    expect(weightedScore).toBeCloseTo(0.7);
  });

  it('should default to 0.5 utility when utilityScore is undefined', () => {
    const memory = makeMemoryEntry('a');  // no utilityScore
    const [{ weightedScore }] = weightByUtility([memory], [1.0]);
    // 0.7 + (0.5 * 0.6) = 1.0
    expect(weightedScore).toBeCloseTo(1.0);
  });

  it('should fall back to base score of 1.0 when scores array is shorter', () => {
    const memories = [makeMemoryEntry('a', 0.5), makeMemoryEntry('b', 0.5)];
    const result = weightByUtility(memories, [2.0]); // only one score
    // second memory gets baseScore = 1.0
    expect(result[1].weightedScore).toBeCloseTo(1.0);
  });

  it('should return an empty array for empty inputs', () => {
    expect(weightByUtility([], [])).toEqual([]);
  });

  it('should include the original memory in each result', () => {
    const memory = makeMemoryEntry('test-id', 0.5);
    const [{ memory: resultMemory }] = weightByUtility([memory], [1.0]);
    expect(resultMemory).toBe(memory);
  });
});

// ---------------------------------------------------------------------------
// UtilityTracker
// ---------------------------------------------------------------------------

describe('UtilityTracker', () => {
  describe('recordFeedback', () => {
    it('should return true and record feedback without a sessionId', () => {
      const tracker = new UtilityTracker();
      const recorded = tracker.recordFeedback('mem-1', 'helpful');
      expect(recorded).toBe(true);
      expect(tracker.getFeedbackHistory('mem-1').length).toBe(1);
    });

    it('should record multiple different signals for the same memory', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful');
      tracker.recordFeedback('mem-1', 'harmful');
      expect(tracker.getFeedbackHistory('mem-1').length).toBe(2);
    });

    it('should return false for duplicate signal in the same session', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      const second = tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      expect(second).toBe(false);
      expect(tracker.getFeedbackHistory('mem-1').length).toBe(1);
    });

    it('should allow the same signal across different sessions', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      const second = tracker.recordFeedback('mem-1', 'helpful', 'session-B');
      expect(second).toBe(true);
      expect(tracker.getFeedbackHistory('mem-1').length).toBe(2);
    });

    it('should allow helpful and harmful in the same session for the same memory', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      const harmfulResult = tracker.recordFeedback('mem-1', 'harmful', 'session-A');
      // different signal → not a duplicate
      expect(harmfulResult).toBe(true);
    });

    it('should record optional context field', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful', undefined, 'some context');
      const history = tracker.getFeedbackHistory('mem-1');
      expect(history[0].context).toBe('some context');
    });
  });

  describe('getFeedbackHistory', () => {
    it('should return an empty array for an unknown memoryId', () => {
      const tracker = new UtilityTracker();
      expect(tracker.getFeedbackHistory('nonexistent')).toEqual([]);
    });

    it('should only return records for the requested memoryId', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful');
      tracker.recordFeedback('mem-2', 'harmful');
      const history = tracker.getFeedbackHistory('mem-1');
      expect(history.every(r => r.memoryId === 'mem-1')).toBe(true);
    });
  });

  describe('getFeedbackSince', () => {
    it('should return records after the given timestamp', () => {
      const tracker = new UtilityTracker();
      const past = new Date(Date.now() - 10000);
      tracker.recordFeedback('mem-1', 'helpful');
      const results = tracker.getFeedbackSince(past);
      expect(results.length).toBe(1);
    });

    it('should return an empty array when no feedback is recent enough', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful');
      const future = new Date(Date.now() + 10000);
      expect(tracker.getFeedbackSince(future)).toEqual([]);
    });
  });

  describe('clearSession', () => {
    it('should allow the same feedback to be recorded again after session is cleared', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      tracker.clearSession('session-A');
      const result = tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      expect(result).toBe(true);
    });

    it('should not affect feedback history (only session dedup map)', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      tracker.clearSession('session-A');
      // History record is preserved even after session is cleared
      expect(tracker.getFeedbackHistory('mem-1').length).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should report zero totals for a fresh tracker', () => {
      const tracker = new UtilityTracker();
      const stats = tracker.getStats();
      expect(stats.totalFeedback).toBe(0);
      expect(stats.helpfulCount).toBe(0);
      expect(stats.harmfulCount).toBe(0);
      expect(stats.uniqueMemories).toBe(0);
      expect(stats.activeSessions).toBe(0);
    });

    it('should count helpful and harmful signals correctly', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful');
      tracker.recordFeedback('mem-2', 'harmful');
      tracker.recordFeedback('mem-3', 'helpful');
      const stats = tracker.getStats();
      expect(stats.helpfulCount).toBe(2);
      expect(stats.harmfulCount).toBe(1);
      expect(stats.totalFeedback).toBe(3);
    });

    it('should count unique memories across all feedback', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful');
      tracker.recordFeedback('mem-1', 'harmful');
      tracker.recordFeedback('mem-2', 'helpful');
      expect(tracker.getStats().uniqueMemories).toBe(2);
    });

    it('should count active sessions', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      tracker.recordFeedback('mem-2', 'helpful', 'session-B');
      expect(tracker.getStats().activeSessions).toBe(2);
    });

    it('should decrement active sessions after clearSession', () => {
      const tracker = new UtilityTracker();
      tracker.recordFeedback('mem-1', 'helpful', 'session-A');
      tracker.clearSession('session-A');
      expect(tracker.getStats().activeSessions).toBe(0);
    });
  });
});
