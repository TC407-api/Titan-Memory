/**
 * Tests for data-dependent decay strategies
 * Target file: src/utils/decay-strategies.ts
 */

import {
  DEFAULT_HALF_LIVES,
  detectContentType,
  calculateTimeOnlyDecay,
  calculateDataDependentDecay,
  DecayCalculator,
  createDecayCalculator,
  estimateTimeToDecay,
} from '../src/utils/decay-strategies';
import { ContentType, DataDependentDecayConfig, MemoryEntry, MemoryLayer } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

function makeMemory(
  content: string,
  overrides: Partial<{
    lastAccessed: string;
    utilityScore: number;
    accessCount: number;
    surpriseScore: number;
    timestamp: Date;
  }> = {}
): MemoryEntry {
  return {
    id: 'test-id',
    content,
    layer: MemoryLayer.LONG_TERM,
    timestamp: overrides.timestamp ?? new Date(),
    metadata: {
      lastAccessed: overrides.lastAccessed,
      utilityScore: overrides.utilityScore,
      accessCount: overrides.accessCount,
      surpriseScore: overrides.surpriseScore,
    },
  };
}

// ---------------------------------------------------------------------------
// DEFAULT_HALF_LIVES
// ---------------------------------------------------------------------------

describe('DEFAULT_HALF_LIVES', () => {
  it('should define a half-life for every ContentType', () => {
    const types: ContentType[] = [
      'decision', 'error', 'solution', 'architecture',
      'learning', 'preference', 'general',
    ];
    for (const t of types) {
      expect(DEFAULT_HALF_LIVES[t]).toBeGreaterThan(0);
    }
  });

  it('should give decisions the longest or tied-longest half-life', () => {
    const max = Math.max(...Object.values(DEFAULT_HALF_LIVES));
    expect(DEFAULT_HALF_LIVES.decision).toBe(max);
  });

  it('should give errors the shortest half-life', () => {
    const min = Math.min(...Object.values(DEFAULT_HALF_LIVES));
    expect(DEFAULT_HALF_LIVES.error).toBe(min);
  });

  it('should give architecture the same half-life as decision', () => {
    expect(DEFAULT_HALF_LIVES.architecture).toBe(DEFAULT_HALF_LIVES.decision);
  });

  it('should give general the same half-life as learning', () => {
    expect(DEFAULT_HALF_LIVES.general).toBe(DEFAULT_HALF_LIVES.learning);
  });
});

// ---------------------------------------------------------------------------
// detectContentType
// ---------------------------------------------------------------------------

describe('detectContentType', () => {
  describe('decision', () => {
    it('should detect "decided"', () => {
      expect(detectContentType('We decided to use PostgreSQL')).toBe('decision');
    });

    it('should detect "chose"', () => {
      expect(detectContentType('The team chose React over Vue')).toBe('decision');
    });

    it('should detect "went with"', () => {
      expect(detectContentType('We went with TypeScript')).toBe('decision');
    });

    it('should be case-insensitive', () => {
      expect(detectContentType('DECIDED TO REFACTOR')).toBe('decision');
    });
  });

  describe('error', () => {
    it('should detect "error"', () => {
      expect(detectContentType('An error occurred in the auth module')).toBe('error');
    });

    it('should detect "bug"', () => {
      expect(detectContentType('Found a bug in the parser')).toBe('error');
    });

    it('should detect "exception"', () => {
      expect(detectContentType('NullPointerException thrown on startup')).toBe('error');
    });

    it('should detect "failed"', () => {
      expect(detectContentType('The build failed due to missing dep')).toBe('error');
    });
  });

  describe('solution', () => {
    it('should detect "fixed"', () => {
      expect(detectContentType('We fixed the memory leak')).toBe('solution');
    });

    it('should detect "resolved"', () => {
      // "Issue" triggers ERROR before SOLUTION, so use plain content with "resolved"
      expect(detectContentType('The ticket was resolved by upgrading the package')).toBe('solution');
    });

    it('should detect "fix was"', () => {
      expect(detectContentType('The fix was to add null checks')).toBe('solution');
    });

    it('should detect "workaround"', () => {
      expect(detectContentType('A workaround is to restart the service')).toBe('solution');
    });
  });

  describe('architecture', () => {
    it('should detect "architecture"', () => {
      expect(detectContentType('The overall architecture uses microservices')).toBe('architecture');
    });

    it('should detect "pattern"', () => {
      expect(detectContentType('We use a repository pattern for data access')).toBe('architecture');
    });

    it('should detect "structure"', () => {
      expect(detectContentType('The folder structure follows domain-driven design')).toBe('architecture');
    });
  });

  describe('learning', () => {
    it('should detect "learned"', () => {
      expect(detectContentType('I learned that async/await is cleaner')).toBe('learning');
    });

    it('should detect "discovered"', () => {
      expect(detectContentType('Discovered that caching reduces latency')).toBe('learning');
    });

    it('should detect "realized"', () => {
      expect(detectContentType('Realized the bottleneck was in the query')).toBe('learning');
    });
  });

  describe('preference', () => {
    it('should detect "prefer"', () => {
      expect(detectContentType('I prefer using functional components')).toBe('preference');
    });

    it('should detect "should"', () => {
      expect(detectContentType('We should always validate user input')).toBe('preference');
    });

    it('should detect "want"', () => {
      expect(detectContentType('The client wants dark mode')).toBe('preference');
    });
  });

  describe('general (fallback)', () => {
    it('should return general for unclassified content', () => {
      expect(detectContentType('The sky is blue today')).toBe('general');
    });

    it('should return general for empty string', () => {
      expect(detectContentType('')).toBe('general');
    });

    it('should return general for numeric-only content', () => {
      expect(detectContentType('12345 67890')).toBe('general');
    });
  });

  describe('priority ordering', () => {
    it('should prefer decision over error when both patterns present', () => {
      // "decided" matches DECISION; "error" also present but DECISION checked first
      const result = detectContentType('We decided to handle the error differently');
      expect(result).toBe('decision');
    });

    it('should prefer error over solution when decision absent', () => {
      // "error" matched before "fixed" in priority order
      const result = detectContentType('The error was fixed by the new release');
      expect(result).toBe('error');
    });
  });
});

// ---------------------------------------------------------------------------
// calculateTimeOnlyDecay
// ---------------------------------------------------------------------------

describe('calculateTimeOnlyDecay', () => {
  it('should return 1.0 for brand-new memory (0 days elapsed)', () => {
    const now = new Date();
    const decay = calculateTimeOnlyDecay(now, now, 180);
    expect(decay).toBeCloseTo(1.0, 3);
  });

  it('should return ~0.5 after exactly one half-life', () => {
    const created = daysAgo(180);
    const decay = calculateTimeOnlyDecay(created, created, 180);
    expect(decay).toBeCloseTo(0.5, 2);
  });

  it('should return ~0.25 after two half-lives', () => {
    const created = daysAgo(360);
    const decay = calculateTimeOnlyDecay(created, created, 180);
    expect(decay).toBeCloseTo(0.25, 2);
  });

  it('should use the default half-life of 180 days when omitted', () => {
    const created = daysAgo(180);
    const decayDefault = calculateTimeOnlyDecay(created, created);
    const decayExplicit = calculateTimeOnlyDecay(created, created, 180);
    expect(decayDefault).toBeCloseTo(decayExplicit, 5);
  });

  it('should use the more recent date (min days elapsed)', () => {
    // Memory created 90 days ago, last accessed 1 day ago → effective = 1 day
    const created = daysAgo(90);
    const recentAccess = daysAgo(1);
    const decay = calculateTimeOnlyDecay(created, recentAccess, 180);
    // Should be close to decay for 1 day, not 90 days
    const decayOneDay = calculateTimeOnlyDecay(daysAgo(1), daysAgo(1), 180);
    expect(decay).toBeCloseTo(decayOneDay, 2);
  });

  it('should produce lower decay for older memories', () => {
    const old = daysAgo(300);
    const recent = daysAgo(30);
    expect(calculateTimeOnlyDecay(old, old, 180))
      .toBeLessThan(calculateTimeOnlyDecay(recent, recent, 180));
  });

  it('should decay faster with a shorter half-life', () => {
    const created = daysAgo(90);
    const slowDecay = calculateTimeOnlyDecay(created, created, 365);
    const fastDecay = calculateTimeOnlyDecay(created, created, 90);
    expect(fastDecay).toBeLessThan(slowDecay);
  });

  it('should decay slower with a longer half-life', () => {
    const created = daysAgo(90);
    const shortHL = calculateTimeOnlyDecay(created, created, 45);
    const longHL = calculateTimeOnlyDecay(created, created, 365);
    expect(longHL).toBeGreaterThan(shortHL);
  });

  it('should always return a value between 0 and 1', () => {
    const veryOld = daysAgo(3650);
    const decay = calculateTimeOnlyDecay(veryOld, veryOld, 180);
    expect(decay).toBeGreaterThanOrEqual(0);
    expect(decay).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// calculateDataDependentDecay
// ---------------------------------------------------------------------------

describe('calculateDataDependentDecay', () => {
  const baseConfig: DataDependentDecayConfig = {
    strategy: 'data-dependent',
    utilityWeight: 1.0,
    accessWeight: 1.0,
  };

  it('should return close to 1.0 for a brand-new memory', () => {
    const memory = makeMemory('We decided to use Redis');
    const decay = calculateDataDependentDecay(memory, baseConfig);
    expect(decay).toBeCloseTo(1.0, 2);
  });

  it('should use DEFAULT_HALF_LIVES for the detected content type', () => {
    // "decision" has 365-day half-life; 365 days ago → ~0.5
    const memory = makeMemory('We decided to migrate to Kubernetes', {
      timestamp: daysAgo(365),
    });
    const decay = calculateDataDependentDecay(memory, baseConfig);
    // utilityScore default 0.5, utilityMult = 0.5 + 0.5*1.0 = 1.0
    // accessCount default 0,   accessMult  = 1 + 0 = 1.0
    // effectiveHL = 365 * 1.0 * 1.0 = 365
    expect(decay).toBeCloseTo(0.5, 1);
  });

  it('should respect halfLifeOverrides in config', () => {
    const config: DataDependentDecayConfig = {
      ...baseConfig,
      halfLifeOverrides: { general: 30 },
    };
    // 30 days elapsed, override half-life = 30 → ~0.5
    const memory = makeMemory('The sky is blue today', { timestamp: daysAgo(30) });
    const decay = calculateDataDependentDecay(memory, config);
    // utilityMult=1.0, accessMult=1.0 → effectiveHL=30
    expect(decay).toBeCloseTo(0.5, 1);
  });

  it('should accept an overrideContentType argument', () => {
    // Content looks like "error" but we force "decision" (HL 365)
    const memory = makeMemory('The bug failed the build', { timestamp: daysAgo(365) });
    const decay = calculateDataDependentDecay(memory, baseConfig, 'decision');
    expect(decay).toBeCloseTo(0.5, 1);
  });

  it('should increase effective half-life for high-utility memories', () => {
    const highUtility = makeMemory('We chose microservices', { utilityScore: 1.0, timestamp: daysAgo(100) });
    const lowUtility  = makeMemory('We chose microservices', { utilityScore: 0.0, timestamp: daysAgo(100) });
    const decayHigh = calculateDataDependentDecay(highUtility, baseConfig);
    const decayLow  = calculateDataDependentDecay(lowUtility,  baseConfig);
    expect(decayHigh).toBeGreaterThan(decayLow);
  });

  it('should increase effective half-life for frequently-accessed memories', () => {
    const frequent = makeMemory('We chose microservices', { accessCount: 10, timestamp: daysAgo(100) });
    const rare     = makeMemory('We chose microservices', { accessCount: 0,  timestamp: daysAgo(100) });
    const decayFrequent = calculateDataDependentDecay(frequent, baseConfig);
    const decayRare     = calculateDataDependentDecay(rare,     baseConfig);
    expect(decayFrequent).toBeGreaterThan(decayRare);
  });

  it('should fall back to creation date when lastAccessed is absent', () => {
    const memory: MemoryEntry = {
      id: 'x',
      content: 'general content here',
      layer: MemoryLayer.LONG_TERM,
      timestamp: daysAgo(180),
      metadata: {},
    };
    const decay = calculateDataDependentDecay(memory, baseConfig);
    // With no lastAccessed, uses timestamp = 180 days ago
    // content type = general (HL 180), utilityMult=1.0, accessMult=1.0
    expect(decay).toBeCloseTo(0.5, 1);
  });

  it('should use lastAccessed when it is more recent than creation', () => {
    const memory = makeMemory('I learned about caching', {
      timestamp: daysAgo(90),
      lastAccessed: daysAgo(1).toISOString(),
    });
    const decayWithAccess = calculateDataDependentDecay(memory, baseConfig);
    const memoryNoAccess  = makeMemory('I learned about caching', { timestamp: daysAgo(90) });
    const decayNoAccess   = calculateDataDependentDecay(memoryNoAccess, baseConfig);
    // Recent access means fewer effective days → higher decay score
    expect(decayWithAccess).toBeGreaterThan(decayNoAccess);
  });

  it('should cap the access multiplier contribution at 0.5', () => {
    const manyAccesses = makeMemory('We decided', { accessCount: 100, timestamp: daysAgo(100) });
    const maxAccesses  = makeMemory('We decided', { accessCount: 1000, timestamp: daysAgo(100) });
    const decayMany = calculateDataDependentDecay(manyAccesses, baseConfig);
    const decayMax  = calculateDataDependentDecay(maxAccesses,  baseConfig);
    // Both should saturate the cap; decay values should be equal (or very close)
    expect(decayMany).toBeCloseTo(decayMax, 5);
  });

  it('should always return a value between 0 and 1', () => {
    const veryOld = makeMemory('The sky is blue', { timestamp: daysAgo(5000) });
    const decay = calculateDataDependentDecay(veryOld, baseConfig);
    expect(decay).toBeGreaterThanOrEqual(0);
    expect(decay).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// DecayCalculator — constructor and getStrategy / getHalfLives
// ---------------------------------------------------------------------------

describe('DecayCalculator', () => {
  describe('constructor defaults', () => {
    it('should default strategy to "time-only"', () => {
      const calc = new DecayCalculator();
      expect(calc.getStrategy()).toBe('time-only');
    });

    it('should accept a strategy override', () => {
      const calc = new DecayCalculator({ strategy: 'data-dependent' });
      expect(calc.getStrategy()).toBe('data-dependent');
    });
  });

  describe('getHalfLives', () => {
    it('should return DEFAULT_HALF_LIVES when no overrides', () => {
      const calc = new DecayCalculator();
      const hl = calc.getHalfLives();
      expect(hl).toEqual(DEFAULT_HALF_LIVES);
    });

    it('should merge overrides on top of defaults', () => {
      const calc = new DecayCalculator({ halfLifeOverrides: { error: 999 } });
      const hl = calc.getHalfLives();
      expect(hl.error).toBe(999);
      expect(hl.decision).toBe(DEFAULT_HALF_LIVES.decision);
    });
  });

  // -------------------------------------------------------------------------
  // calculate
  // -------------------------------------------------------------------------

  describe('calculate', () => {
    it('should use time-only decay when strategy is "time-only"', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      const memory = makeMemory('Hello world', { timestamp: daysAgo(180) });
      const result = calc.calculate(memory);
      expect(result).toBeCloseTo(0.5, 1);
    });

    it('should accept a custom halfLifeDays override in time-only mode', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      const memory = makeMemory('Hello world', { timestamp: daysAgo(90) });
      // 90-day half-life → 90 days elapsed → ~0.5
      const result = calc.calculate(memory, 90);
      expect(result).toBeCloseTo(0.5, 1);
    });

    it('should use data-dependent decay when strategy is "data-dependent"', () => {
      const calc = new DecayCalculator({ strategy: 'data-dependent' });
      const memory = makeMemory('We decided to refactor', { timestamp: daysAgo(365) });
      const result = calc.calculate(memory);
      // decision HL=365, multipliers default ~1.0 → ~0.5
      expect(result).toBeCloseTo(0.5, 1);
    });

    it('should fall back to creation timestamp when lastAccessed is absent', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      const memory: MemoryEntry = {
        id: 'y',
        content: 'test',
        layer: MemoryLayer.LONG_TERM,
        timestamp: daysAgo(180),
        metadata: {},
      };
      expect(calc.calculate(memory)).toBeCloseTo(0.5, 1);
    });
  });

  // -------------------------------------------------------------------------
  // calculateWithType
  // -------------------------------------------------------------------------

  describe('calculateWithType', () => {
    it('should use the provided content type half-life in time-only mode', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      // Force "error" type (HL=90) on a 90-day-old memory → ~0.5
      const memory = makeMemory('completely generic content', { timestamp: daysAgo(90) });
      const result = calc.calculateWithType(memory, 'error');
      expect(result).toBeCloseTo(0.5, 1);
    });

    it('should override detected content type in time-only mode', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      const memory = makeMemory('The bug caused a crash', { timestamp: daysAgo(90) });
      // Would normally detect "error" (HL=90); force "decision" (HL=365)
      const withDecision = calc.calculateWithType(memory, 'decision');
      const withError    = calc.calculateWithType(memory, 'error');
      // decision HL longer → slower decay → higher score at same age
      expect(withDecision).toBeGreaterThan(withError);
    });

    it('should use data-dependent path with content type override', () => {
      const calc = new DecayCalculator({ strategy: 'data-dependent' });
      const memory = makeMemory('The sky is blue', { timestamp: daysAgo(365) });
      // force "decision" (HL=365) → ~0.5
      const result = calc.calculateWithType(memory, 'decision');
      expect(result).toBeCloseTo(0.5, 1);
    });
  });

  // -------------------------------------------------------------------------
  // getEffectiveHalfLife
  // -------------------------------------------------------------------------

  describe('getEffectiveHalfLife', () => {
    it('should return the base half-life in time-only mode', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      // content "We decided …" → decision (HL=365)
      const memory = makeMemory('We decided to proceed');
      expect(calc.getEffectiveHalfLife(memory)).toBe(365);
    });

    it('should apply multipliers in data-dependent mode', () => {
      const calc = new DecayCalculator({ strategy: 'data-dependent', utilityWeight: 1.0, accessWeight: 1.0 });
      // general content (HL=180), utilityScore=1.0, accessCount=0
      // utilityMult = 0.5 + 1.0*1.0 = 1.5, accessMult=1.0 → effectiveHL=270
      const memory = makeMemory('The sky is blue', { utilityScore: 1.0, accessCount: 0 });
      expect(calc.getEffectiveHalfLife(memory)).toBeCloseTo(270, 0);
    });

    it('should use halfLifeOverrides when set', () => {
      const calc = new DecayCalculator({
        strategy: 'time-only',
        halfLifeOverrides: { general: 999 },
      });
      const memory = makeMemory('The sky is blue');
      expect(calc.getEffectiveHalfLife(memory)).toBe(999);
    });

    it('should cap accessMult contribution at 0.5', () => {
      const calc = new DecayCalculator({ strategy: 'data-dependent', utilityWeight: 1.0, accessWeight: 1.0 });
      // accessCount=100 → accessMult capped at 1.5
      // general HL=180, utilityScore=0.5 → utilityMult=1.0, accessMult=1.5 → HL=270
      const memory = makeMemory('The sky is blue', { utilityScore: 0.5, accessCount: 100 });
      const hl = calc.getEffectiveHalfLife(memory);
      // max possible = 180 * 1.5 * 1.5 = 405
      expect(hl).toBeLessThanOrEqual(405);
      expect(hl).toBeGreaterThan(180);
    });
  });

  // -------------------------------------------------------------------------
  // shouldPrune
  // -------------------------------------------------------------------------

  describe('shouldPrune', () => {
    it('should return false for a fresh memory', () => {
      const calc = new DecayCalculator();
      const memory = makeMemory('Fresh content');
      expect(calc.shouldPrune(memory)).toBe(false);
    });

    it('should return true when decay is below default threshold (0.05)', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      // 2^(-t/180) < 0.05 → t > 180 * log2(20) ≈ 776 days
      const memory = makeMemory('Very old content', { timestamp: daysAgo(800) });
      expect(calc.shouldPrune(memory)).toBe(true);
    });

    it('should respect a custom threshold', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      // At 180 days decay ≈ 0.5; threshold 0.6 → should prune
      const memory = makeMemory('Old content', { timestamp: daysAgo(180) });
      expect(calc.shouldPrune(memory, 0.6)).toBe(true);
    });

    it('should not prune when decay equals threshold exactly boundary', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      // decay just above 0.05 (e.g. 700 days for HL=180: 2^(-700/180) ≈ 0.068)
      const memory = makeMemory('Not quite prunable', { timestamp: daysAgo(700) });
      expect(calc.shouldPrune(memory, 0.05)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // rankByRelevance
  // -------------------------------------------------------------------------

  describe('rankByRelevance', () => {
    it('should return an empty array for empty input', () => {
      const calc = new DecayCalculator();
      expect(calc.rankByRelevance([])).toEqual([]);
    });

    it('should return one item for single-element input', () => {
      const calc = new DecayCalculator();
      const memory = makeMemory('Solo memory');
      const ranked = calc.rankByRelevance([memory]);
      expect(ranked).toHaveLength(1);
      expect(ranked[0].memory).toBe(memory);
    });

    it('should sort by effectiveScore descending', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      const recent = makeMemory('Recent memory', { surpriseScore: 0.9, timestamp: new Date() });
      const old    = makeMemory('Old memory',    { surpriseScore: 0.9, timestamp: daysAgo(500) });
      const ranked = calc.rankByRelevance([old, recent]);
      expect(ranked[0].memory).toBe(recent);
    });

    it('should include decay and effectiveScore fields on each item', () => {
      const calc = new DecayCalculator();
      const memory = makeMemory('Test', { surpriseScore: 0.8 });
      const [item] = calc.rankByRelevance([memory]);
      expect(item.decay).toBeDefined();
      expect(item.effectiveScore).toBeDefined();
      expect(item.effectiveScore).toBeCloseTo(item.decay * 0.8, 5);
    });

    it('should default surpriseScore to 0.5 when absent', () => {
      const calc = new DecayCalculator();
      const memory: MemoryEntry = {
        id: 'no-surprise',
        content: 'generic',
        layer: MemoryLayer.LONG_TERM,
        timestamp: new Date(),
        metadata: {},
      };
      const [item] = calc.rankByRelevance([memory]);
      expect(item.effectiveScore).toBeCloseTo(item.decay * 0.5, 5);
    });

    it('should rank high-surprise recent memory above low-surprise old memory', () => {
      const calc = new DecayCalculator();
      const highRecent = makeMemory('A', { surpriseScore: 1.0, timestamp: new Date() });
      const lowOld     = makeMemory('B', { surpriseScore: 0.1, timestamp: daysAgo(500) });
      const ranked = calc.rankByRelevance([lowOld, highRecent]);
      expect(ranked[0].memory).toBe(highRecent);
    });
  });

  // -------------------------------------------------------------------------
  // updateConfig
  // -------------------------------------------------------------------------

  describe('updateConfig', () => {
    it('should update strategy mid-session', () => {
      const calc = new DecayCalculator({ strategy: 'time-only' });
      calc.updateConfig({ strategy: 'data-dependent' });
      expect(calc.getStrategy()).toBe('data-dependent');
    });

    it('should merge partial config without losing existing fields', () => {
      const calc = new DecayCalculator({ strategy: 'time-only', utilityWeight: 2.0 });
      calc.updateConfig({ accessWeight: 0.5 });
      // strategy should still be time-only, utilityWeight 2.0
      expect(calc.getStrategy()).toBe('time-only');
    });

    it('should update halfLifeOverrides', () => {
      const calc = new DecayCalculator();
      calc.updateConfig({ halfLifeOverrides: { error: 45 } });
      expect(calc.getHalfLives().error).toBe(45);
    });
  });
});

// ---------------------------------------------------------------------------
// createDecayCalculator
// ---------------------------------------------------------------------------

describe('createDecayCalculator', () => {
  it('should return a DecayCalculator instance', () => {
    const calc = createDecayCalculator();
    expect(calc).toBeInstanceOf(DecayCalculator);
  });

  it('should pass config to the underlying DecayCalculator', () => {
    const calc = createDecayCalculator({ strategy: 'data-dependent' });
    expect(calc.getStrategy()).toBe('data-dependent');
  });

  it('should work without arguments', () => {
    const calc = createDecayCalculator();
    expect(calc.getStrategy()).toBe('time-only');
  });
});

// ---------------------------------------------------------------------------
// estimateTimeToDecay
// ---------------------------------------------------------------------------

describe('estimateTimeToDecay', () => {
  it('should return 0 for a memory already below the threshold', () => {
    // 800-day-old memory in time-only mode (HL=180) has decay << 0.05
    const memory = makeMemory('Very old', { timestamp: daysAgo(800) });
    const days = estimateTimeToDecay(memory, 0.05);
    expect(days).toBe(0);
  });

  it('should return a positive number for a fresh memory', () => {
    const memory = makeMemory('Fresh memory');
    const days = estimateTimeToDecay(memory, 0.05);
    expect(days).toBeGreaterThan(0);
  });

  it('should return fewer days remaining for an older memory', () => {
    const recent = makeMemory('New', { timestamp: daysAgo(10) });
    const older  = makeMemory('Old', { timestamp: daysAgo(300) });
    const daysRecent = estimateTimeToDecay(recent, 0.05);
    const daysOlder  = estimateTimeToDecay(older,  0.05);
    expect(daysRecent).toBeGreaterThan(daysOlder);
  });

  it('should use the default threshold of 0.05 when omitted', () => {
    const memory = makeMemory('Fresh', { timestamp: daysAgo(1) });
    const withDefault  = estimateTimeToDecay(memory);
    const withExplicit = estimateTimeToDecay(memory, 0.05);
    expect(withDefault).toBeCloseTo(withExplicit, 3);
  });

  it('should return fewer days for a higher threshold', () => {
    const memory = makeMemory('Content', { timestamp: daysAgo(10) });
    const lowThreshold  = estimateTimeToDecay(memory, 0.01);
    const highThreshold = estimateTimeToDecay(memory, 0.5);
    expect(highThreshold).toBeLessThan(lowThreshold);
  });

  it('should account for data-dependent config when provided', () => {
    const config: DataDependentDecayConfig = {
      strategy: 'data-dependent',
      utilityWeight: 1.0,
      accessWeight: 1.0,
    };
    // High-utility memory decays slower → more days remaining
    const highUtility = makeMemory('We decided to scale', { utilityScore: 1.0, timestamp: daysAgo(10) });
    const lowUtility  = makeMemory('We decided to scale', { utilityScore: 0.0, timestamp: daysAgo(10) });
    const daysHigh = estimateTimeToDecay(highUtility, 0.05, config);
    const daysLow  = estimateTimeToDecay(lowUtility,  0.05, config);
    expect(daysHigh).toBeGreaterThan(daysLow);
  });

  it('should never return a negative number', () => {
    const veryOld = makeMemory('Ancient', { timestamp: daysAgo(5000) });
    expect(estimateTimeToDecay(veryOld, 0.05)).toBeGreaterThanOrEqual(0);
  });

  it('should handle threshold of 0.5 (one half-life remaining estimate)', () => {
    // Fresh memory with HL=180 in time-only mode; threshold=0.5 → ~180 days from now minus ~0 elapsed
    const memory = makeMemory('Fresh', { timestamp: daysAgo(1) });
    const days = estimateTimeToDecay(memory, 0.5);
    // Should be approximately 179 days (180 - 1 already elapsed)
    expect(days).toBeGreaterThan(170);
    expect(days).toBeLessThan(185);
  });
});
