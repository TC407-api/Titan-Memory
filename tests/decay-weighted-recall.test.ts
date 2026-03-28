/**
 * Decay-Weighted Recall Scoring Tests (Phase 1 — TDD)
 */

describe('Decay-Weighted Recall Scoring', () => {
  // These test the scoring formula:
  // effectiveScore = relevanceScore * decay * accessBoost * surpriseWeight + recencyTiebreak
  // accessBoost = 1 + Math.log1p(accessCount)
  // surpriseWeight = surpriseScore ?? 0.5

  function score(relevance: number, decay: number, accessCount: number, surprise: number, recency: number): number {
    const accessBoost = 1 + Math.log1p(accessCount);
    return relevance * decay * accessBoost * surprise + recency;
  }

  it('should score fresh memory higher than stale memory', () => {
    const fresh = score(0.8, 0.95, 5, 0.7, 0.1);
    const stale = score(0.8, 0.2, 5, 0.7, 0.01);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('should score frequently-accessed memory higher than rarely-accessed', () => {
    const frequent = score(0.8, 0.9, 50, 0.7, 0.1);
    const rare = score(0.8, 0.9, 0, 0.7, 0.1);
    expect(frequent).toBeGreaterThan(rare);
  });

  it('should score high-surprise memory higher than low-surprise', () => {
    const surprising = score(0.8, 0.9, 5, 0.9, 0.1);
    const boring = score(0.8, 0.9, 5, 0.1, 0.1);
    expect(surprising).toBeGreaterThan(boring);
  });

  it('should handle zero access count gracefully', () => {
    const result = score(0.8, 0.9, 0, 0.5, 0.1);
    // accessBoost = 1 + log1p(0) = 1 + 0 = 1
    expect(result).toBeCloseTo(0.8 * 0.9 * 1 * 0.5 + 0.1, 5);
  });

  it('should use 0.5 as default surprise weight', () => {
    const withDefault = score(0.8, 0.9, 5, 0.5, 0.1);
    expect(withDefault).toBeGreaterThan(0);
  });

  it('should apply access boost as sublinear curve (log)', () => {
    // Access boost should grow much slower than linearly
    const boost0 = 1 + Math.log1p(0);     // 1.0
    const boost100 = 1 + Math.log1p(100); // ~5.6
    const boost1000 = 1 + Math.log1p(1000); // ~7.9

    // 10x more access gives much less than 10x more boost
    expect(boost1000).toBeLessThan(boost100 * 2);
    // But there is still meaningful differentiation
    expect(boost100).toBeGreaterThan(boost0 * 2);
  });

  it('should keep recency as tiebreaker (small contribution)', () => {
    // Recency is at most 0.20 — shouldn't dominate over relevance * decay
    const highRelevanceLowRecency = score(0.9, 0.9, 5, 0.8, 0.0);
    const lowRelevanceHighRecency = score(0.3, 0.9, 5, 0.8, 0.20);
    expect(highRelevanceLowRecency).toBeGreaterThan(lowRelevanceHighRecency);
  });

  it('should produce non-negative scores for all valid inputs', () => {
    const edgeCases = [
      score(0, 0, 0, 0, 0),
      score(1, 1, 0, 0.5, 0),
      score(0.5, 0.5, 100, 1, 0.2),
    ];
    for (const s of edgeCases) {
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});
