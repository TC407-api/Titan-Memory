/**
 * Pattern Matcher Tests
 * Comprehensive coverage for PatternMatcher class, createPatternMatcher, and quickMatch
 */

import {
  PatternMatcher,
  createPatternMatcher,
  quickMatch,
} from '../src/learning/pattern-matcher';
import { TransferablePattern } from '../src/types';
import { IEmbeddingGenerator } from '../src/storage/vector-storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePattern(overrides: Partial<TransferablePattern> = {}): TransferablePattern {
  return {
    patternId: 'pat-' + Math.random().toString(36).substr(2, 9),
    sourceProject: 'project-a',
    content: 'React hooks enable stateful functional components',
    distilledContent: undefined,
    applicability: 0.8,
    domain: 'frontend',
    stage: 'mature',
    transferCount: 3,
    ...overrides,
  };
}

function makeMockEmbeddingGenerator(
  vectorFn?: (text: string) => number[]
): IEmbeddingGenerator {
  return {
    generateEmbedding: jest.fn().mockImplementation(async (text: string) => {
      if (vectorFn) return vectorFn(text);
      // Return identical unit vectors so cosine similarity === 1.0
      return [1, 0, 0];
    }),
    getDimension: jest.fn().mockReturnValue(3),
  };
}

// ---------------------------------------------------------------------------
// PatternMatcher — constructor and basic setup
// ---------------------------------------------------------------------------

describe('PatternMatcher', () => {
  describe('constructor', () => {
    it('should instantiate without an embedding generator', () => {
      const matcher = new PatternMatcher();
      expect(matcher).toBeInstanceOf(PatternMatcher);
    });

    it('should instantiate with an embedding generator', () => {
      const generator = makeMockEmbeddingGenerator();
      const matcher = new PatternMatcher(generator);
      expect(matcher).toBeInstanceOf(PatternMatcher);
    });
  });

  // -------------------------------------------------------------------------
  // setEmbeddingGenerator
  // -------------------------------------------------------------------------

  describe('setEmbeddingGenerator', () => {
    it('should replace the embedding generator and clear the cache', async () => {
      const gen1 = makeMockEmbeddingGenerator();
      const matcher = new PatternMatcher(gen1);

      // Warm the cache with one embedding call
      const pattern = makePattern({ content: 'some content about caching' });
      await matcher.match('some content', [pattern], { minRelevance: 0 });
      expect(matcher.getCacheStats().size).toBeGreaterThan(0);

      // Replace generator — cache must be wiped
      const gen2 = makeMockEmbeddingGenerator();
      matcher.setEmbeddingGenerator(gen2);
      expect(matcher.getCacheStats().size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // match — happy path
  // -------------------------------------------------------------------------

  describe('match', () => {
    it('should return results above minRelevance threshold', async () => {
      const matcher = new PatternMatcher();
      const pattern = makePattern({
        content: 'typescript generics improve type safety in large codebases',
      });

      const results = await matcher.match(
        'typescript generics type safety',
        [pattern],
        { minRelevance: 0.1 }
      );

      expect(results.length).toBe(1);
      expect(results[0].relevance).toBeGreaterThanOrEqual(0.1);
    });

    it('should exclude results below minRelevance threshold', async () => {
      const matcher = new PatternMatcher();
      const pattern = makePattern({ content: 'database indexing performance' });

      const results = await matcher.match(
        'unrelated query about cooking recipes',
        [pattern],
        { minRelevance: 0.9 }
      );

      expect(results.length).toBe(0);
    });

    it('should return results sorted by descending relevance', async () => {
      const matcher = new PatternMatcher();
      const patterns = [
        makePattern({ content: 'node express server api routes endpoints' }),
        makePattern({ content: 'node express api routes' }),
        makePattern({ content: 'express api routes handler middleware' }),
      ];

      const results = await matcher.match(
        'node express api routes',
        patterns,
        { minRelevance: 0 }
      );

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].relevance).toBeGreaterThanOrEqual(results[i].relevance);
      }
    });

    it('should respect maxResults option', async () => {
      const matcher = new PatternMatcher();
      const patterns = Array.from({ length: 10 }, () =>
        makePattern({ content: 'react component state hooks' })
      );

      const results = await matcher.match('react hooks', patterns, {
        minRelevance: 0,
        maxResults: 3,
      });

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should return empty array when patterns list is empty', async () => {
      const matcher = new PatternMatcher();
      const results = await matcher.match('any query', [], { minRelevance: 0 });
      expect(results).toEqual([]);
    });

    it('should cap relevance at 1.0', async () => {
      const matcher = new PatternMatcher();
      // Identical content + high applicability could push score above 1
      const pattern = makePattern({
        content: 'react hooks state',
        distilledContent: 'react hooks state',
        applicability: 1.0,
      });

      const results = await matcher.match('react hooks state', [pattern], {
        minRelevance: 0,
      });

      for (const r of results) {
        expect(r.relevance).toBeLessThanOrEqual(1.0);
      }
    });

    // -----------------------------------------------------------------------
    // match — domain filtering
    // -----------------------------------------------------------------------

    it('should filter patterns by specified domains', async () => {
      const matcher = new PatternMatcher();
      const frontendPattern = makePattern({ domain: 'frontend', content: 'react hooks state' });
      const backendPattern = makePattern({ domain: 'backend', content: 'react hooks state' });

      const results = await matcher.match(
        'react hooks',
        [frontendPattern, backendPattern],
        { minRelevance: 0, domains: ['frontend'] }
      );

      expect(results.every(r => r.pattern.domain === 'frontend')).toBe(true);
    });

    it('should always include "general" domain patterns when domain filter is active', async () => {
      const matcher = new PatternMatcher();
      const generalPattern = makePattern({ domain: 'general', content: 'react hooks state' });
      const backendPattern = makePattern({ domain: 'backend', content: 'react hooks state' });

      const results = await matcher.match(
        'react hooks',
        [generalPattern, backendPattern],
        { minRelevance: 0, domains: ['frontend'] }
      );

      const ids = results.map(r => r.pattern.patternId);
      expect(ids).toContain(generalPattern.patternId);
      expect(ids).not.toContain(backendPattern.patternId);
    });

    it('should not filter by domain when domains option is empty', async () => {
      const matcher = new PatternMatcher();
      const patterns = [
        makePattern({ domain: 'frontend', content: 'react hooks state' }),
        makePattern({ domain: 'backend', content: 'react hooks state' }),
      ];

      const results = await matcher.match('react hooks', patterns, {
        minRelevance: 0,
        domains: [],
      });

      expect(results.length).toBe(2);
    });

    // -----------------------------------------------------------------------
    // match — excludeProjects filtering
    // -----------------------------------------------------------------------

    it('should exclude patterns from specified projects', async () => {
      const matcher = new PatternMatcher();
      const ownPattern = makePattern({ sourceProject: 'my-project', content: 'react hooks state' });
      const otherPattern = makePattern({ sourceProject: 'other-project', content: 'react hooks state' });

      const results = await matcher.match(
        'react hooks',
        [ownPattern, otherPattern],
        { minRelevance: 0, excludeProjects: ['my-project'] }
      );

      expect(results.every(r => r.pattern.sourceProject !== 'my-project')).toBe(true);
    });

    // -----------------------------------------------------------------------
    // match — distilled content boosting
    // -----------------------------------------------------------------------

    it('should prefer distilledContent over content when boostDistilled is true', async () => {
      const matcher = new PatternMatcher();
      const patternWithDistilled = makePattern({
        content: 'irrelevant base content about dogs',
        distilledContent: 'typescript generics improve reusability',
      });
      const patternWithoutDistilled = makePattern({
        content: 'typescript generics improve reusability',
        distilledContent: undefined,
      });

      const results = await matcher.match(
        'typescript generics reusability',
        [patternWithDistilled, patternWithoutDistilled],
        { minRelevance: 0, boostDistilled: true }
      );

      // Both should match; distilled one gets boost so should not score zero
      expect(results.length).toBe(2);
      const distilledResult = results.find(
        r => r.pattern.patternId === patternWithDistilled.patternId
      );
      expect(distilledResult).toBeDefined();
      expect(distilledResult!.relevance).toBeGreaterThan(0);
    });

    it('should fall back to content when boostDistilled is false', async () => {
      const matcher = new PatternMatcher();
      const pattern = makePattern({
        content: 'react hooks state management',
        distilledContent: 'some unrelated distilled notes',
      });

      const resultsWithBoost = await matcher.match(
        'react hooks',
        [pattern],
        { minRelevance: 0, boostDistilled: false }
      );

      // Should still return a result — just without the distilled content path
      expect(resultsWithBoost.length).toBe(1);
    });

    // -----------------------------------------------------------------------
    // match — semantic (embedding) path
    // -----------------------------------------------------------------------

    it('should use embedding generator when provided and return a result', async () => {
      const generator = makeMockEmbeddingGenerator(() => [1, 0, 0]);
      const matcher = new PatternMatcher(generator);
      const pattern = makePattern({ content: 'any content here' });

      const results = await matcher.match('any query', [pattern], { minRelevance: 0 });

      expect(generator.generateEmbedding).toHaveBeenCalled();
      expect(results.length).toBe(1);
    });

    it('should fall back to contentSimilarity when embedding generator throws', async () => {
      const generator: IEmbeddingGenerator = {
        generateEmbedding: jest.fn().mockRejectedValue(new Error('API failure')),
        getDimension: jest.fn().mockReturnValue(3),
      };
      const matcher = new PatternMatcher(generator);
      const pattern = makePattern({ content: 'react hooks state' });

      // Should not throw — falls back gracefully
      const results = await matcher.match('react hooks', [pattern], { minRelevance: 0 });
      expect(Array.isArray(results)).toBe(true);
    });

    it('should cache embeddings and not call generator twice for same text', async () => {
      const generator = makeMockEmbeddingGenerator();
      const matcher = new PatternMatcher(generator);
      const pattern = makePattern({ content: 'cached content text' });

      // Two calls with the same query — embedding for query should only be generated once
      await matcher.match('cached content text', [pattern], { minRelevance: 0 });
      await matcher.match('cached content text', [pattern], { minRelevance: 0 });

      // The query text is the same in both calls; generator should reuse cache on second call
      const callArgs = (generator.generateEmbedding as jest.Mock).mock.calls.map(
        (c: string[]) => c[0]
      );
      const uniqueCalls = new Set(callArgs);
      // "cached content text" appears as both query and content — should only appear once per unique string
      expect(uniqueCalls.size).toBeLessThan(callArgs.length);
    });
  });

  // -------------------------------------------------------------------------
  // match — matchedTerms
  // -------------------------------------------------------------------------

  describe('matchedTerms', () => {
    it('should populate matchedTerms with overlapping words longer than 2 chars', async () => {
      const matcher = new PatternMatcher();
      const pattern = makePattern({ content: 'javascript promises async await fetch' });

      const results = await matcher.match(
        'javascript async fetch',
        [pattern],
        { minRelevance: 0 }
      );

      expect(results.length).toBe(1);
      const terms = results[0].matchedTerms;
      expect(terms).toContain('javascript');
      expect(terms).toContain('async');
      expect(terms).toContain('fetch');
    });

    it('should exclude short tokens (2 chars or fewer) from matchedTerms', async () => {
      const matcher = new PatternMatcher();
      const pattern = makePattern({ content: 'go is a fast language' });

      const results = await matcher.match('go is fast', [pattern], { minRelevance: 0 });

      const terms = results[0]?.matchedTerms ?? [];
      // "go" and "is" are <= 2 chars — must not appear
      expect(terms).not.toContain('go');
      expect(terms).not.toContain('is');
    });

    it('should use distilledContent for matchedTerms when available', async () => {
      const matcher = new PatternMatcher();
      const pattern = makePattern({
        content: 'completely different base content',
        distilledContent: 'typescript interfaces improve contracts',
      });

      const results = await matcher.match(
        'typescript interfaces contracts',
        [pattern],
        { minRelevance: 0 }
      );

      const terms = results[0]?.matchedTerms ?? [];
      expect(terms).toContain('typescript');
      expect(terms).toContain('interfaces');
    });
  });

  // -------------------------------------------------------------------------
  // findBestMatch
  // -------------------------------------------------------------------------

  describe('findBestMatch', () => {
    it('should return the single highest-relevance match', async () => {
      const matcher = new PatternMatcher();
      const patterns = [
        makePattern({ content: 'react hooks state management components' }),
        makePattern({ content: 'completely unrelated database migration topic' }),
      ];

      const best = await matcher.findBestMatch('react hooks state', patterns, {
        minRelevance: 0,
      });

      expect(best).not.toBeNull();
      expect(best!.pattern.content).toContain('react');
    });

    it('should return null when no patterns pass the minRelevance threshold', async () => {
      const matcher = new PatternMatcher();
      const pattern = makePattern({ content: 'zzz totally unrelated content xyz' });

      const best = await matcher.findBestMatch('completely different topic', [pattern], {
        minRelevance: 0.99,
      });

      expect(best).toBeNull();
    });

    it('should return null for an empty patterns array', async () => {
      const matcher = new PatternMatcher();
      const best = await matcher.findBestMatch('any query', []);
      expect(best).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // groupByDomain
  // -------------------------------------------------------------------------

  describe('groupByDomain', () => {
    it('should group patterns into correct domain buckets', () => {
      const matcher = new PatternMatcher();
      const p1 = makePattern({ domain: 'frontend' });
      const p2 = makePattern({ domain: 'backend' });
      const p3 = makePattern({ domain: 'frontend' });

      const grouped = matcher.groupByDomain([p1, p2, p3]);

      expect(grouped.get('frontend')).toHaveLength(2);
      expect(grouped.get('backend')).toHaveLength(1);
    });

    it('should default to "general" domain when pattern domain is falsy', () => {
      const matcher = new PatternMatcher();
      const pattern = makePattern({ domain: '' });

      const grouped = matcher.groupByDomain([pattern]);

      expect(grouped.has('general')).toBe(true);
      expect(grouped.get('general')).toHaveLength(1);
    });

    it('should return an empty Map for an empty patterns array', () => {
      const matcher = new PatternMatcher();
      const grouped = matcher.groupByDomain([]);
      expect(grouped.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // clearCache / getCacheStats
  // -------------------------------------------------------------------------

  describe('clearCache', () => {
    it('should reset cache size to zero', async () => {
      const generator = makeMockEmbeddingGenerator();
      const matcher = new PatternMatcher(generator);
      const pattern = makePattern({ content: 'warm the cache' });

      await matcher.match('warm the cache', [pattern], { minRelevance: 0 });
      expect(matcher.getCacheStats().size).toBeGreaterThan(0);

      matcher.clearCache();
      expect(matcher.getCacheStats().size).toBe(0);
    });
  });

  describe('getCacheStats', () => {
    it('should report maxSize of 1000', () => {
      const matcher = new PatternMatcher();
      expect(matcher.getCacheStats().maxSize).toBe(1000);
    });

    it('should start with size 0 before any matches', () => {
      const matcher = new PatternMatcher();
      expect(matcher.getCacheStats().size).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// createPatternMatcher factory
// ---------------------------------------------------------------------------

describe('createPatternMatcher', () => {
  it('should return a PatternMatcher instance without a generator', () => {
    const matcher = createPatternMatcher();
    expect(matcher).toBeInstanceOf(PatternMatcher);
  });

  it('should return a PatternMatcher instance with a generator', () => {
    const generator = makeMockEmbeddingGenerator();
    const matcher = createPatternMatcher(generator);
    expect(matcher).toBeInstanceOf(PatternMatcher);
  });
});

// ---------------------------------------------------------------------------
// quickMatch convenience function
// ---------------------------------------------------------------------------

describe('quickMatch', () => {
  it('should return matches above the default minRelevance of 0.5', async () => {
    const pattern = makePattern({
      content: 'typescript type safety generics interfaces unions',
      applicability: 1.0,
    });

    const results = await quickMatch(
      'typescript type safety generics interfaces',
      [pattern]
    );

    // High overlap — should pass 0.5 threshold
    expect(results.length).toBe(1);
    expect(results[0].relevance).toBeGreaterThanOrEqual(0.5);
  });

  it('should accept a custom minRelevance parameter', async () => {
    const pattern = makePattern({ content: 'barely relevant distant topic' });

    const strictResults = await quickMatch('barely relevant', [pattern], 0.99);
    const lenientResults = await quickMatch('barely relevant', [pattern], 0.0);

    expect(strictResults.length).toBe(0);
    expect(lenientResults.length).toBe(1);
  });

  it('should return empty array when no patterns are provided', async () => {
    const results = await quickMatch('any query', []);
    expect(results).toEqual([]);
  });

  it('should return PatternMatchResult objects with expected shape', async () => {
    const pattern = makePattern({
      content: 'react state management hooks components',
      applicability: 0.9,
    });

    const results = await quickMatch('react state hooks', [pattern], 0);

    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r).toHaveProperty('pattern');
    expect(r).toHaveProperty('relevance');
    expect(r).toHaveProperty('matchedTerms');
    expect(typeof r.relevance).toBe('number');
    expect(Array.isArray(r.matchedTerms)).toBe(true);
  });
});
