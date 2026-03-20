/**
 * Extended ToolHandler tests — covers handlers not exercised in mcp.test.ts
 * All TitanMemory I/O is mocked; no network/disk calls occur.
 *
 * NOTE: jest.mock() is hoisted before variable declarations, so the mock
 * factory cannot close over a `const mockTitan` defined at module scope.
 * Instead we export the mock object from the factory via a module-level
 * object reference that is populated synchronously inside the factory.
 */

import { ToolHandler } from '../src/mcp/tools';
import { initTitan } from '../src/titan';

// ---------------------------------------------------------------------------
// jest.mock must reference only literals / require() inside its factory
// ---------------------------------------------------------------------------
jest.mock('../src/titan', () => {
  const titan = {
    add: jest.fn(),
    addToLayer: jest.fn(),
    recall: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    getStats: jest.fn(),
    flushPreCompaction: jest.fn(),
    curate: jest.fn(),
    getToday: jest.fn(),
    prune: jest.fn(),
    recordFeedback: jest.fn(),
    suggest: jest.fn(),
    findRelevantPatterns: jest.fn(),
    getMirasStats: jest.fn(),
    classifyContent: jest.fn(),
    getCategorySummary: jest.fn(),
    checkCategorySufficiency: jest.fn(),
    logNoop: jest.fn(),
    getNoopStats: jest.fn(),
    detectQueryIntent: jest.fn(),
    createCausalLink: jest.fn(),
    traceCausalChain: jest.fn(),
    explainMemory: jest.fn(),
    addFocus: jest.fn(),
    getFocus: jest.fn(),
    getFocusContext: jest.fn(),
    clearFocus: jest.fn(),
    removeFocus: jest.fn(),
    getScratchpad: jest.fn(),
    setScratchpad: jest.fn(),
    appendScratchpad: jest.fn(),
    clearScratchpad: jest.fn(),
    compress: jest.fn(),
    expand: jest.fn(),
    close: jest.fn(),
  };
  return {
    initTitan: jest.fn().mockResolvedValue(titan),
    TitanMemory: jest.fn(),
    __mockTitan: titan,
  };
});

// ---------------------------------------------------------------------------
// Retrieve the shared mock instance from the module after mocking
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTitan = (require('../src/titan') as any).__mockTitan;
const mockInitTitan = initTitan as jest.MockedFunction<typeof initTitan>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function textOf(result: { content: Array<{ type: string; text: string }> }) {
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('ToolHandler — extended coverage', () => {
  let handler: ToolHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-attach the titan mock after clearAllMocks resets mockResolvedValue
    mockInitTitan.mockResolvedValue(mockTitan as never);
    handler = new ToolHandler();
  });

  afterEach(async () => {
    await handler.close();
  });

  // ── titan_add with explicit layer ──────────────────────────────────────
  describe('titan_add', () => {
    it('should call addToLayer when layer is provided', async () => {
      const entry = { id: 'mem-1', content: 'layered memory' };
      mockTitan.addToLayer.mockResolvedValue(entry);

      const result = await handler.handleToolCall('titan_add', {
        content: 'layered memory',
        layer: 3,
        tags: ['arch'],
        projectId: 'proj-x',
      });

      expect(mockTitan.addToLayer).toHaveBeenCalledWith(3, 'layered memory', {
        tags: ['arch'],
        projectId: 'proj-x',
      });
      expect(parseText(result)).toEqual(entry);
    });

    it('should call add when no layer is provided', async () => {
      const entry = { id: 'mem-2', content: 'auto-routed memory' };
      mockTitan.add.mockResolvedValue(entry);

      const result = await handler.handleToolCall('titan_add', {
        content: 'auto-routed memory',
      });

      expect(mockTitan.add).toHaveBeenCalledWith('auto-routed memory', {
        tags: undefined,
        projectId: undefined,
      });
      expect(parseText(result)).toEqual(entry);
    });
  });

  // ── titan_delete ──────────────────────────────────────────────────────
  describe('titan_delete', () => {
    it('should return deleted true and id when deletion succeeds', async () => {
      mockTitan.delete.mockResolvedValue(true);

      const result = await handler.handleToolCall('titan_delete', { id: 'mem-abc' });

      expect(mockTitan.delete).toHaveBeenCalledWith('mem-abc');
      expect(parseText(result)).toEqual({ deleted: true, id: 'mem-abc' });
    });

    it('should return deleted false when memory does not exist', async () => {
      mockTitan.delete.mockResolvedValue(false);

      const result = await handler.handleToolCall('titan_delete', { id: 'missing-id' });

      expect(parseText(result).deleted).toBe(false);
    });
  });

  // ── titan_flush ───────────────────────────────────────────────────────
  describe('titan_flush', () => {
    it('should flush with provided session data', async () => {
      const flushResult = { memoriesStored: 3 };
      mockTitan.flushPreCompaction.mockResolvedValue(flushResult);

      const result = await handler.handleToolCall('titan_flush', {
        sessionId: 'sess-42',
        insights: ['insight A'],
        decisions: ['use Postgres'],
        errors: ['timeout on write'],
        solutions: ['retry with backoff'],
      });

      const callArg = mockTitan.flushPreCompaction.mock.calls[0][0];
      expect(callArg.sessionId).toBe('sess-42');
      expect(callArg.importantInsights).toEqual(['insight A']);
      expect(callArg.decisions).toEqual(['use Postgres']);
      expect(parseText(result)).toEqual(flushResult);
    });

    it('should auto-generate sessionId when none is provided', async () => {
      mockTitan.flushPreCompaction.mockResolvedValue({ memoriesStored: 0 });

      await handler.handleToolCall('titan_flush', {});

      const callArg = mockTitan.flushPreCompaction.mock.calls[0][0];
      expect(callArg.sessionId).toMatch(/^session-\d+$/);
      expect(callArg.importantInsights).toEqual([]);
    });
  });

  // ── titan_curate ──────────────────────────────────────────────────────
  describe('titan_curate', () => {
    it('should call curate and return success with content and section', async () => {
      mockTitan.curate.mockResolvedValue(undefined);

      const result = await handler.handleToolCall('titan_curate', {
        content: 'Use kebab-case for filenames',
        section: 'Preferences',
      });

      expect(mockTitan.curate).toHaveBeenCalledWith(
        'Use kebab-case for filenames',
        'Preferences'
      );
      const parsed = parseText(result);
      expect(parsed.success).toBe(true);
      expect(parsed.content).toBe('Use kebab-case for filenames');
      expect(parsed.section).toBe('Preferences');
    });
  });

  // ── titan_prune (live run) ────────────────────────────────────────────
  describe('titan_prune', () => {
    it('should call prune with thresholds when dryRun is false', async () => {
      const pruneResult = { pruned: 5, remaining: 95 };
      mockTitan.prune.mockResolvedValue(pruneResult);

      const result = await handler.handleToolCall('titan_prune', {
        dryRun: false,
        decayThreshold: 0.1,
        utilityThreshold: 0.3,
      });

      expect(mockTitan.prune).toHaveBeenCalledWith({
        decayThreshold: 0.1,
        utilityThreshold: 0.3,
      });
      expect(parseText(result)).toEqual(pruneResult);
    });
  });

  // ── titan_feedback ────────────────────────────────────────────────────
  describe('titan_feedback', () => {
    it('should record helpful feedback with context', async () => {
      const feedbackResult = { id: 'mem-1', utilityScore: 0.8 };
      mockTitan.recordFeedback.mockResolvedValue(feedbackResult);

      const result = await handler.handleToolCall('titan_feedback', {
        id: 'mem-1',
        signal: 'helpful',
        context: 'resolved the bug',
        sessionId: 'sess-99',
      });

      expect(mockTitan.recordFeedback).toHaveBeenCalledWith(
        'mem-1',
        'helpful',
        'sess-99',
        'resolved the bug'
      );
      expect(parseText(result)).toEqual(feedbackResult);
    });

    it('should record harmful feedback without optional fields', async () => {
      mockTitan.recordFeedback.mockResolvedValue({ id: 'mem-2', utilityScore: 0.1 });

      await handler.handleToolCall('titan_feedback', {
        id: 'mem-2',
        signal: 'harmful',
      });

      expect(mockTitan.recordFeedback).toHaveBeenCalledWith(
        'mem-2',
        'harmful',
        undefined,
        undefined
      );
    });
  });

  // ── titan_suggest ─────────────────────────────────────────────────────
  describe('titan_suggest', () => {
    it('should return suggestions with count and truncated context when over 100 chars', async () => {
      const suggestions = [{ id: 's1', content: 'suggestion one' }];
      mockTitan.suggest.mockResolvedValue(suggestions);

      const longContext = 'a'.repeat(200);
      const result = await handler.handleToolCall('titan_suggest', {
        context: longContext,
        limit: 3,
        minRelevance: 0.6,
        includeHighlighting: false,
      });

      const parsed = parseText(result);
      expect(parsed.count).toBe(1);
      expect(parsed.suggestions).toEqual(suggestions);
      // 100 chars + '...' = 103
      expect(parsed.context).toHaveLength(103);
      expect(parsed.context).toMatch(/\.\.\.$/);
    });

    it('should not append ellipsis when context is 100 chars or fewer', async () => {
      mockTitan.suggest.mockResolvedValue([]);

      const result = await handler.handleToolCall('titan_suggest', { context: 'short' });

      expect(parseText(result).context).toBe('short');
    });
  });

  // ── titan_patterns ────────────────────────────────────────────────────
  describe('titan_patterns', () => {
    it('should map pattern results to simplified shape using distilledContent', async () => {
      const rawPatterns = [
        {
          pattern: {
            patternId: 'p-1',
            sourceProject: 'findseptic',
            domain: 'backend',
            distilledContent: 'Use indexes on foreign keys',
            content: 'full content here',
            applicability: 0.9,
          },
          relevance: 0.85,
          matchedTerms: ['index', 'foreign'],
        },
      ];
      mockTitan.findRelevantPatterns.mockResolvedValue(rawPatterns);

      const result = await handler.handleToolCall('titan_patterns', {
        query: 'database indexing',
        limit: 5,
      });

      const parsed = parseText(result);
      expect(parsed.count).toBe(1);
      expect(parsed.patterns[0].patternId).toBe('p-1');
      expect(parsed.patterns[0].content).toBe('Use indexes on foreign keys');
      expect(parsed.patterns[0].relevance).toBe(0.85);
    });

    it('should fall back to truncated content when distilledContent is absent', async () => {
      const rawPatterns = [
        {
          pattern: {
            patternId: 'p-2',
            sourceProject: 'proj',
            domain: 'general',
            content: 'x'.repeat(300),
            applicability: 0.5,
          },
          relevance: 0.7,
          matchedTerms: [],
        },
      ];
      mockTitan.findRelevantPatterns.mockResolvedValue(rawPatterns);

      const result = await handler.handleToolCall('titan_patterns', { query: 'anything' });

      expect(parseText(result).patterns[0].content).toHaveLength(200);
    });
  });

  // ── titan_miras_stats ─────────────────────────────────────────────────
  describe('titan_miras_stats', () => {
    it('should return MIRAS stats object', async () => {
      const stats = { embeddings: 42, highlights: 10 };
      mockTitan.getMirasStats.mockResolvedValue(stats);

      const result = await handler.handleToolCall('titan_miras_stats', {});

      expect(parseText(result)).toEqual(stats);
    });
  });

  // ── titan_classify ────────────────────────────────────────────────────
  describe('titan_classify', () => {
    it('should return classification result for provided content', async () => {
      const classification = { category: 'knowledge', confidence: 0.95, method: 'rules' };
      mockTitan.classifyContent.mockReturnValue(classification);

      const result = await handler.handleToolCall('titan_classify', {
        content: 'TypeScript uses structural typing',
      });

      expect(mockTitan.classifyContent).toHaveBeenCalledWith('TypeScript uses structural typing');
      expect(parseText(result)).toEqual(classification);
    });
  });

  // ── titan_category_summary ────────────────────────────────────────────
  describe('titan_category_summary', () => {
    it('should return summary when cortex returns a value', async () => {
      const summary = { category: 'knowledge', count: 15, summary: 'TypeScript patterns' };
      mockTitan.getCategorySummary.mockReturnValue(summary);

      const result = await handler.handleToolCall('titan_category_summary', {
        category: 'knowledge',
      });

      expect(parseText(result)).toEqual(summary);
    });

    it('should return error object when cortex returns null', async () => {
      mockTitan.getCategorySummary.mockReturnValue(null);

      const result = await handler.handleToolCall('titan_category_summary', {
        category: 'skill',
      });

      expect(parseText(result).error).toMatch(/Cortex not enabled/);
    });
  });

  // ── titan_sufficiency ─────────────────────────────────────────────────
  describe('titan_sufficiency', () => {
    it('should recall memories when no memoryIds provided', async () => {
      mockTitan.recall.mockResolvedValue({ fusedMemories: [{ id: 'm1' }] });
      mockTitan.checkCategorySufficiency.mockReturnValue({ sufficient: true, coverage: 1.0 });

      const result = await handler.handleToolCall('titan_sufficiency', {
        query: 'test query',
      });

      expect(mockTitan.recall).toHaveBeenCalledWith('test query', { limit: 20 });
      expect(parseText(result).sufficient).toBe(true);
    });

    it('should fetch individual memories when memoryIds are provided, skipping nulls', async () => {
      mockTitan.get.mockResolvedValueOnce({ id: 'm1', content: 'mem one' });
      mockTitan.get.mockResolvedValueOnce(null);
      mockTitan.checkCategorySufficiency.mockReturnValue({ sufficient: false, coverage: 0.5 });

      const result = await handler.handleToolCall('titan_sufficiency', {
        query: 'coverage check',
        memoryIds: ['m1', 'missing'],
      });

      expect(mockTitan.get).toHaveBeenCalledTimes(2);
      const passedMemories = mockTitan.checkCategorySufficiency.mock.calls[0][0];
      expect(passedMemories).toHaveLength(1);
      expect(parseText(result).sufficient).toBe(false);
    });
  });

  // ── titan_noop ────────────────────────────────────────────────────────
  describe('titan_noop', () => {
    it('should log noop with all fields', async () => {
      const noopResult = { logged: true, reason: 'duplicate' };
      mockTitan.logNoop.mockResolvedValue(noopResult);

      const result = await handler.handleToolCall('titan_noop', {
        reason: 'duplicate',
        context: 'already stored this fact',
        contentPreview: 'TypeScript is...',
        sessionId: 'sess-1',
        projectId: 'proj-a',
      });

      expect(mockTitan.logNoop).toHaveBeenCalledWith({
        reason: 'duplicate',
        context: 'already stored this fact',
        contentPreview: 'TypeScript is...',
        sessionId: 'sess-1',
        projectId: 'proj-a',
      });
      expect(parseText(result)).toEqual(noopResult);
    });
  });

  // ── titan_noop_stats ──────────────────────────────────────────────────
  describe('titan_noop_stats', () => {
    it('should return noop statistics', async () => {
      const stats = { total: 20, byReason: { duplicate: 10, noise: 10 } };
      mockTitan.getNoopStats.mockResolvedValue(stats);

      const result = await handler.handleToolCall('titan_noop_stats', {});

      expect(parseText(result)).toEqual(stats);
    });
  });

  // ── titan_intent ──────────────────────────────────────────────────────
  describe('titan_intent', () => {
    it('should detect intent for a query', async () => {
      const intentResult = { intent: 'recall', confidence: 0.9, recommendedLayers: [3, 4] };
      mockTitan.detectQueryIntent.mockReturnValue(intentResult);

      const result = await handler.handleToolCall('titan_intent', {
        query: 'what did I decide about the database?',
      });

      expect(mockTitan.detectQueryIntent).toHaveBeenCalledWith(
        'what did I decide about the database?'
      );
      expect(parseText(result)).toEqual(intentResult);
    });
  });

  // ── titan_link ────────────────────────────────────────────────────────
  describe('titan_link', () => {
    it('should create a causal link between two memories', async () => {
      const linkResult = { linkId: 'lnk-1', created: true };
      mockTitan.createCausalLink.mockResolvedValue(linkResult);

      const result = await handler.handleToolCall('titan_link', {
        fromMemoryId: 'mem-cause',
        toMemoryId: 'mem-effect',
        relationship: 'causes',
        strength: 0.8,
        evidence: 'observed correlation in logs',
      });

      expect(mockTitan.createCausalLink).toHaveBeenCalledWith({
        fromMemoryId: 'mem-cause',
        toMemoryId: 'mem-effect',
        relationship: 'causes',
        strength: 0.8,
        evidence: 'observed correlation in logs',
      });
      expect(parseText(result)).toEqual(linkResult);
    });
  });

  // ── titan_trace ───────────────────────────────────────────────────────
  describe('titan_trace', () => {
    it('should trace causal chain with direction and depth', async () => {
      const chain = { nodes: ['mem-1', 'mem-2'], combinedStrength: 0.6 };
      mockTitan.traceCausalChain.mockResolvedValue(chain);

      const result = await handler.handleToolCall('titan_trace', {
        memoryId: 'mem-1',
        depth: 3,
        direction: 'forward',
      });

      expect(mockTitan.traceCausalChain).toHaveBeenCalledWith('mem-1', {
        depth: 3,
        direction: 'forward',
      });
      expect(parseText(result)).toEqual(chain);
    });
  });

  // ── titan_why ─────────────────────────────────────────────────────────
  describe('titan_why', () => {
    it('should explain a memory passing undefined maxDepth by default', async () => {
      const explanation = { directCauses: ['mem-0'], rootCauses: [] };
      mockTitan.explainMemory.mockResolvedValue(explanation);

      const result = await handler.handleToolCall('titan_why', { memoryId: 'mem-99' });

      expect(mockTitan.explainMemory).toHaveBeenCalledWith('mem-99', undefined);
      expect(parseText(result)).toEqual(explanation);
    });
  });

  // ── titan_focus_add ───────────────────────────────────────────────────
  describe('titan_focus_add', () => {
    it('should add item to working memory focus with all options', async () => {
      const focusItem = { id: 'f-1', content: 'fix the auth bug', priority: 'high' };
      mockTitan.addFocus.mockResolvedValue(focusItem);

      const result = await handler.handleToolCall('titan_focus_add', {
        content: 'fix the auth bug',
        priority: 'high',
        ttlMs: 60000,
        source: 'user',
      });

      expect(mockTitan.addFocus).toHaveBeenCalledWith('fix the auth bug', {
        priority: 'high',
        ttlMs: 60000,
        source: 'user',
      });
      expect(parseText(result)).toEqual(focusItem);
    });
  });

  // ── titan_focus_list ──────────────────────────────────────────────────
  describe('titan_focus_list', () => {
    it('should return focus items list when asContext is false', async () => {
      const items = [{ id: 'f-1', content: 'task A' }];
      mockTitan.getFocus.mockResolvedValue(items);

      const result = await handler.handleToolCall('titan_focus_list', { asContext: false });

      expect(mockTitan.getFocus).toHaveBeenCalled();
      expect(parseText(result)).toEqual(items);
    });

    it('should return formatted context string when asContext is true', async () => {
      mockTitan.getFocusContext.mockResolvedValue('## Focus\n- task A');

      const result = await handler.handleToolCall('titan_focus_list', { asContext: true });

      expect(mockTitan.getFocusContext).toHaveBeenCalled();
      expect(textOf(result)).toContain('Focus');
    });
  });

  // ── titan_focus_clear ─────────────────────────────────────────────────
  describe('titan_focus_clear', () => {
    it('should clear all focus items', async () => {
      const clearResult = { cleared: 3 };
      mockTitan.clearFocus.mockResolvedValue(clearResult);

      const result = await handler.handleToolCall('titan_focus_clear', {});

      expect(mockTitan.clearFocus).toHaveBeenCalled();
      expect(parseText(result)).toEqual(clearResult);
    });
  });

  // ── titan_focus_remove ────────────────────────────────────────────────
  describe('titan_focus_remove', () => {
    it('should remove a specific focus item by id', async () => {
      mockTitan.removeFocus.mockResolvedValue({ removed: true });

      const result = await handler.handleToolCall('titan_focus_remove', { id: 'f-1' });

      expect(mockTitan.removeFocus).toHaveBeenCalledWith('f-1');
      expect(parseText(result).removed).toBe(true);
    });
  });

  // ── titan_scratchpad ──────────────────────────────────────────────────
  describe('titan_scratchpad', () => {
    it('should get scratchpad content', async () => {
      mockTitan.getScratchpad.mockResolvedValue('my notes here');

      const result = await handler.handleToolCall('titan_scratchpad', { action: 'get' });

      expect(mockTitan.getScratchpad).toHaveBeenCalled();
      expect(textOf(result)).toContain('my notes here');
    });

    it('should set scratchpad content and return success', async () => {
      mockTitan.setScratchpad.mockResolvedValue(undefined);

      const result = await handler.handleToolCall('titan_scratchpad', {
        action: 'set',
        content: 'new notes',
      });

      expect(mockTitan.setScratchpad).toHaveBeenCalledWith('new notes');
      expect(parseText(result).success).toBe(true);
    });

    it('should append to scratchpad and return success', async () => {
      mockTitan.appendScratchpad.mockResolvedValue(undefined);

      const result = await handler.handleToolCall('titan_scratchpad', {
        action: 'append',
        content: ' appended',
      });

      expect(mockTitan.appendScratchpad).toHaveBeenCalledWith(' appended');
      expect(parseText(result).success).toBe(true);
    });

    it('should clear scratchpad and return success', async () => {
      mockTitan.clearScratchpad.mockResolvedValue(undefined);

      const result = await handler.handleToolCall('titan_scratchpad', { action: 'clear' });

      expect(mockTitan.clearScratchpad).toHaveBeenCalled();
      expect(parseText(result).success).toBe(true);
    });
  });

  // ── titan_compress ────────────────────────────────────────────────────
  describe('titan_compress', () => {
    it('should compress a memory with targetRatio and contextQuery', async () => {
      const compressed = { entities: ['TypeScript'], summary: 'TS patterns', ratio: 15 };
      mockTitan.compress.mockResolvedValue(compressed);

      const result = await handler.handleToolCall('titan_compress', {
        memoryId: 'mem-10',
        targetRatio: 15,
        contextQuery: 'types',
      });

      expect(mockTitan.compress).toHaveBeenCalledWith('mem-10', {
        targetRatio: 15,
        contextQuery: 'types',
      });
      expect(parseText(result)).toEqual(compressed);
    });
  });

  // ── titan_expand ──────────────────────────────────────────────────────
  describe('titan_expand', () => {
    it('should expand a valid compressed memory JSON string', async () => {
      const expandedText = 'TypeScript uses structural typing for type checking.';
      mockTitan.expand.mockResolvedValue(expandedText);

      const compressedObj = { entities: ['TypeScript'], summary: 'TS patterns' };
      const result = await handler.handleToolCall('titan_expand', {
        compressed: JSON.stringify(compressedObj),
        verbosity: 'detailed',
        format: 'prose',
      });

      expect(mockTitan.expand).toHaveBeenCalledWith(compressedObj, {
        verbosity: 'detailed',
        format: 'prose',
      });
      expect(textOf(result)).toContain(expandedText);
    });

    it('should return Error when compressed is invalid JSON', async () => {
      const result = await handler.handleToolCall('titan_expand', {
        compressed: 'not-valid-json',
      });

      expect(textOf(result)).toMatch(/^Error:/);
    });
  });

  // ── error propagation ─────────────────────────────────────────────────
  describe('error handling', () => {
    it('should prefix message with Error: when a titan method throws an Error', async () => {
      mockTitan.getStats.mockRejectedValue(new Error('DB connection failed'));

      const result = await handler.handleToolCall('titan_stats', {});

      expect(textOf(result)).toBe('Error: DB connection failed');
    });

    it('should convert non-Error thrown values to string', async () => {
      mockTitan.getStats.mockRejectedValue('string error value');

      const result = await handler.handleToolCall('titan_stats', {});

      expect(textOf(result)).toContain('Error:');
    });

    it('should return Unknown tool message for unrecognized tool names', async () => {
      const result = await handler.handleToolCall('titan_nonexistent', {});

      expect(textOf(result)).toContain('Unknown tool: titan_nonexistent');
    });
  });

  // ── close lifecycle ───────────────────────────────────────────────────
  describe('close', () => {
    it('should call titan.close when handler has been initialized', async () => {
      mockTitan.getStats.mockResolvedValue({ totalMemories: 0, byLayer: {} });
      mockTitan.close.mockResolvedValue(undefined);

      await handler.handleToolCall('titan_stats', {});
      await handler.close();

      expect(mockTitan.close).toHaveBeenCalled();
    });

    it('should resolve without error when close is called before any tool call', async () => {
      const freshHandler = new ToolHandler();
      await expect(freshHandler.close()).resolves.not.toThrow();
    });
  });
});
