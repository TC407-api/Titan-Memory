/**
 * Benchmark Scorecard Tests (Phase 0 — TDD RED)
 */

import { generateScorecard, detectRegressions, formatScorecard } from '../src/benchmarks/scorecard';
import type { BenchmarkSuiteResult, BenchmarkResult } from '../src/benchmarks/types';

function makeBenchmarkResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    name: 'test-benchmark',
    category: 'retrieval',
    passed: true,
    score: 85,
    metrics: { accuracy: 0.85, p50: 120, p95: 200 },
    timestamp: new Date('2026-03-28'),
    durationMs: 1000,
    ...overrides,
  };
}

function makeSuiteResult(results: BenchmarkResult[]): BenchmarkSuiteResult {
  return {
    suiteName: 'titan-benchmarks',
    totalTests: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    overallScore: results.reduce((sum, r) => sum + r.score, 0) / results.length,
    results,
    startTime: new Date('2026-03-28T00:00:00Z'),
    endTime: new Date('2026-03-28T00:01:00Z'),
    totalDurationMs: 60000,
  };
}

describe('Scorecard', () => {
  describe('generateScorecard', () => {
    it('should extract key metrics from suite results', () => {
      const suite = makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 90, metrics: { accuracy: 0.90 } }),
        makeBenchmarkResult({ category: 'latency', score: 80, metrics: { p50: 100, p95: 180 } }),
        makeBenchmarkResult({ category: 'token-efficiency', score: 75, metrics: { compressionRatio: 5.2 } }),
      ]);

      const scorecard = generateScorecard(suite);

      expect(scorecard).toHaveProperty('date');
      expect(scorecard).toHaveProperty('overallScore');
      expect(scorecard).toHaveProperty('categories');
      expect(scorecard.overallScore).toBeCloseTo(81.67, 0);
    });

    it('should group metrics by category', () => {
      const suite = makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 90, metrics: { accuracy: 0.90 } }),
        makeBenchmarkResult({ category: 'retrieval', score: 85, metrics: { accuracy: 0.85 } }),
        makeBenchmarkResult({ category: 'latency', score: 70, metrics: { p50: 150 } }),
      ]);

      const scorecard = generateScorecard(suite);

      expect(scorecard.categories.retrieval).toBeDefined();
      expect(scorecard.categories.latency).toBeDefined();
      expect(scorecard.categories.retrieval.avgScore).toBeCloseTo(87.5, 0);
    });

    it('should handle empty suite results', () => {
      const suite = makeSuiteResult([]);
      const scorecard = generateScorecard(suite);

      expect(scorecard.overallScore).toBe(0);
      expect(Object.keys(scorecard.categories)).toHaveLength(0);
    });

    it('should include pass/fail counts', () => {
      const suite = makeSuiteResult([
        makeBenchmarkResult({ passed: true }),
        makeBenchmarkResult({ passed: true }),
        makeBenchmarkResult({ passed: false, score: 30 }),
      ]);

      const scorecard = generateScorecard(suite);

      expect(scorecard.totalTests).toBe(3);
      expect(scorecard.passed).toBe(2);
      expect(scorecard.failed).toBe(1);
    });
  });

  describe('detectRegressions', () => {
    it('should detect regression above threshold', () => {
      const previous = generateScorecard(makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 90 }),
      ]));
      const current = generateScorecard(makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 85 }),
      ]));

      const regressions = detectRegressions(current, previous, 2);

      expect(regressions.length).toBeGreaterThan(0);
      const retrievalRegression = regressions.find(r => r.category === 'retrieval');
      expect(retrievalRegression).toBeDefined();
      expect(retrievalRegression!.delta).toBeLessThan(0);
    });

    it('should not flag improvements as regressions', () => {
      const previous = generateScorecard(makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 80 }),
      ]));
      const current = generateScorecard(makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 90 }),
      ]));

      const regressions = detectRegressions(current, previous, 2);

      expect(regressions).toHaveLength(0);
    });

    it('should not flag changes within threshold', () => {
      const previous = generateScorecard(makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 90 }),
      ]));
      const current = generateScorecard(makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 89 }),
      ]));

      const regressions = detectRegressions(current, previous, 2);

      expect(regressions).toHaveLength(0);
    });

    it('should detect overall score regression', () => {
      const previous = generateScorecard(makeSuiteResult([
        makeBenchmarkResult({ score: 90 }),
        makeBenchmarkResult({ score: 85 }),
      ]));
      const current = generateScorecard(makeSuiteResult([
        makeBenchmarkResult({ score: 80 }),
        makeBenchmarkResult({ score: 75 }),
      ]));

      const regressions = detectRegressions(current, previous, 2);

      expect(regressions.some(r => r.category === 'overall')).toBe(true);
    });
  });

  describe('formatScorecard', () => {
    it('should produce readable markdown', () => {
      const suite = makeSuiteResult([
        makeBenchmarkResult({ category: 'retrieval', score: 90, metrics: { accuracy: 0.90 } }),
        makeBenchmarkResult({ category: 'latency', score: 80, metrics: { p50: 100, p95: 180 } }),
      ]);
      const scorecard = generateScorecard(suite);
      const output = formatScorecard(scorecard);

      expect(typeof output).toBe('string');
      expect(output).toContain('Titan Memory Scorecard');
      expect(output).toContain('retrieval');
      expect(output).toContain('latency');
    });

    it('should include overall score', () => {
      const suite = makeSuiteResult([
        makeBenchmarkResult({ score: 85 }),
      ]);
      const scorecard = generateScorecard(suite);
      const output = formatScorecard(scorecard);

      expect(output).toContain('85');
    });
  });
});
