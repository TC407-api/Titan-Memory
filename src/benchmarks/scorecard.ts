/**
 * Benchmark Scorecard
 * Generates scorecards from benchmark results, detects regressions, formats output.
 */

import type { BenchmarkSuiteResult } from './types.js';

export interface CategoryScore {
  avgScore: number;
  testCount: number;
  passed: number;
  failed: number;
  metrics: Record<string, number>;
}

export interface Scorecard {
  date: string;
  overallScore: number;
  totalTests: number;
  passed: number;
  failed: number;
  categories: Record<string, CategoryScore>;
  durationMs: number;
}

export interface Regression {
  category: string;
  previousScore: number;
  currentScore: number;
  delta: number;
}

/**
 * Generate a scorecard from benchmark suite results.
 */
export function generateScorecard(suite: BenchmarkSuiteResult): Scorecard {
  const categories: Record<string, CategoryScore> = {};

  for (const result of suite.results) {
    if (!categories[result.category]) {
      categories[result.category] = { avgScore: 0, testCount: 0, passed: 0, failed: 0, metrics: {} };
    }
    const cat = categories[result.category];
    cat.testCount++;
    if (result.passed) cat.passed++;
    else cat.failed++;
    cat.avgScore += result.score;

    for (const [key, value] of Object.entries(result.metrics)) {
      cat.metrics[key] = (cat.metrics[key] ?? 0) + value;
    }
  }

  // Average the scores and metrics
  for (const cat of Object.values(categories)) {
    if (cat.testCount > 0) {
      cat.avgScore /= cat.testCount;
      for (const key of Object.keys(cat.metrics)) {
        cat.metrics[key] /= cat.testCount;
      }
    }
  }

  return {
    date: new Date().toISOString().split('T')[0],
    overallScore: suite.results.length > 0 ? suite.overallScore : 0,
    totalTests: suite.totalTests,
    passed: suite.passed,
    failed: suite.failed,
    categories,
    durationMs: suite.totalDurationMs,
  };
}

/**
 * Detect regressions between two scorecards.
 * Returns regressions where score dropped by more than threshold percentage points.
 */
export function detectRegressions(
  current: Scorecard,
  previous: Scorecard,
  threshold: number,
): Regression[] {
  const regressions: Regression[] = [];

  // Check overall score
  const overallDelta = current.overallScore - previous.overallScore;
  if (overallDelta < -threshold) {
    regressions.push({
      category: 'overall',
      previousScore: previous.overallScore,
      currentScore: current.overallScore,
      delta: overallDelta,
    });
  }

  // Check each category
  for (const [cat, prevCatScore] of Object.entries(previous.categories)) {
    const currCatScore = current.categories[cat];
    if (!currCatScore) continue;

    const delta = currCatScore.avgScore - prevCatScore.avgScore;
    if (delta < -threshold) {
      regressions.push({
        category: cat,
        previousScore: prevCatScore.avgScore,
        currentScore: currCatScore.avgScore,
        delta,
      });
    }
  }

  return regressions;
}

/**
 * Format a scorecard as readable markdown.
 */
export function formatScorecard(scorecard: Scorecard): string {
  const lines: string[] = [
    '# Titan Memory Scorecard',
    `**Date:** ${scorecard.date}`,
    `**Overall Score:** ${scorecard.overallScore.toFixed(1)}/100`,
    `**Tests:** ${scorecard.passed}/${scorecard.totalTests} passed`,
    `**Duration:** ${(scorecard.durationMs / 1000).toFixed(1)}s`,
    '',
  ];

  for (const [cat, score] of Object.entries(scorecard.categories)) {
    lines.push(`## ${cat}`);
    lines.push(`- Score: ${score.avgScore.toFixed(1)}/100 (${score.passed}/${score.testCount} passed)`);
    for (const [key, value] of Object.entries(score.metrics)) {
      lines.push(`- ${key}: ${typeof value === 'number' && value < 1 ? (value * 100).toFixed(1) + '%' : value.toFixed(2)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
