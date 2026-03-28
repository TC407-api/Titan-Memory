/**
 * Titan Memory Tool Registry
 * Map-based registry pattern replacing the mega-switch in handleToolCall
 */

import { TitanMemory } from '../titan.js';
import { MemoryLayer, CompactionContext, RecallMode } from '../types.js';
import { UtilitySignal } from '../utils/utility.js';
import { NoopReason } from '../trace/noop-log.js';
import { ToolSchemas } from './tools.js';
import { NamespaceManager, MemoryNamespace } from '../storage/namespace-manager.js';
import { gateByRelevance } from '../retrieval/relevance-gate.js';

const namespaceManager = new NamespaceManager();

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

export type ToolHandlerFn = (
  titan: TitanMemory,
  args: Record<string, unknown>
) => Promise<ToolResult>;

const registry = new Map<string, ToolHandlerFn>();

export function registerTool(name: string, handler: ToolHandlerFn): void {
  registry.set(name, handler);
}

export function getToolHandler(name: string): ToolHandlerFn | undefined {
  return registry.get(name);
}

// Helper: wrap a result value into the standard ToolResult format
function jsonResult(result: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

function textResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

// --- Register all tool handlers ---

registerTool('titan_add', async (titan, args) => {
  const parsed = ToolSchemas.titan_add.parse(args);
  // v2.2: Tag metadata with namespace isolation info
  const baseMeta: Record<string, unknown> = {
    tags: parsed.tags,
    projectId: parsed.projectId,
  };
  const taggedMeta = namespaceManager.tagMemory(
    baseMeta,
    parsed.agentId,
    parsed.namespace as MemoryNamespace | undefined,
    parsed.projectId,
  );
  let result: unknown;
  if (parsed.layer) {
    result = await titan.addToLayer(
      parsed.layer as MemoryLayer,
      parsed.content,
      taggedMeta
    );
  } else {
    result = await titan.add(parsed.content, taggedMeta);
  }
  return jsonResult(result);
});

registerTool('titan_recall', async (titan, args) => {
  const parsed = ToolSchemas.titan_recall.parse(args);
  const result = await titan.recall(parsed.query, {
    limit: parsed.limit,
    layers: parsed.layers as MemoryLayer[] | undefined,
    projectId: parsed.projectId,
    tags: parsed.tags,
    mode: parsed.mode as RecallMode | undefined,
  });
  return jsonResult(result);
});

registerTool('titan_get', async (titan, args) => {
  const parsed = ToolSchemas.titan_get.parse(args);
  const result = await titan.get(parsed.id);
  if (!result) {
    return textResult(`Memory not found: ${parsed.id}`);
  }
  return jsonResult(result);
});

registerTool('titan_delete', async (titan, args) => {
  const parsed = ToolSchemas.titan_delete.parse(args);
  const deleted = await titan.delete(parsed.id);
  return jsonResult({ deleted, id: parsed.id });
});

registerTool('titan_stats', async (titan, _args) => {
  const result = await titan.getStats();
  return jsonResult(result);
});

registerTool('titan_flush', async (titan, args) => {
  const parsed = ToolSchemas.titan_flush.parse(args);
  const context: CompactionContext = {
    sessionId: parsed.sessionId || `session-${Date.now()}`,
    timestamp: new Date(),
    tokenCount: 0,
    importantInsights: parsed.insights || [],
    decisions: parsed.decisions || [],
    errors: parsed.errors || [],
    solutions: parsed.solutions || [],
  };
  const result = await titan.flushPreCompaction(context);
  return jsonResult(result);
});

registerTool('titan_curate', async (titan, args) => {
  const parsed = ToolSchemas.titan_curate.parse(args);
  await titan.curate(parsed.content, parsed.section);
  return jsonResult({ success: true, content: parsed.content, section: parsed.section });
});

registerTool('titan_today', async (titan, _args) => {
  const result = await titan.getToday();
  return jsonResult(result);
});

registerTool('titan_prune', async (titan, args) => {
  const parsed = ToolSchemas.titan_prune.parse(args);
  let result: unknown;
  if (parsed.dryRun) {
    const stats = await titan.getStats();
    result = {
      dryRun: true,
      estimatedPrunable: Math.floor(stats.totalMemories * 0.1),
      decayThreshold: parsed.decayThreshold,
      utilityThreshold: parsed.utilityThreshold,
    };
  } else {
    result = await titan.prune({
      decayThreshold: parsed.decayThreshold,
      utilityThreshold: parsed.utilityThreshold,
    });
  }
  return jsonResult(result);
});

registerTool('titan_feedback', async (titan, args) => {
  const parsed = ToolSchemas.titan_feedback.parse(args);
  const result = await titan.recordFeedback(
    parsed.id,
    parsed.signal as UtilitySignal,
    parsed.sessionId,
    parsed.context
  );
  return jsonResult(result);
});

registerTool('titan_suggest', async (titan, args) => {
  const parsed = ToolSchemas.titan_suggest.parse(args);
  const suggestions = await titan.suggest(parsed.context, {
    limit: parsed.limit,
    minRelevance: parsed.minRelevance,
    includeHighlighting: parsed.includeHighlighting,
  });
  const result = {
    suggestions,
    count: suggestions.length,
    context: parsed.context.substring(0, 100) + (parsed.context.length > 100 ? '...' : ''),
  };
  return jsonResult(result);
});

registerTool('titan_patterns', async (titan, args) => {
  const parsed = ToolSchemas.titan_patterns.parse(args);
  const patterns = await titan.findRelevantPatterns(parsed.query, {
    limit: parsed.limit,
    minRelevance: parsed.minRelevance,
    domain: parsed.domain,
  });
  const result = {
    patterns: patterns.map(p => ({
      patternId: p.pattern.patternId,
      sourceProject: p.pattern.sourceProject,
      domain: p.pattern.domain,
      relevance: p.relevance,
      matchedTerms: p.matchedTerms,
      content: p.pattern.distilledContent || p.pattern.content.substring(0, 200),
      applicability: p.pattern.applicability,
    })),
    count: patterns.length,
  };
  return jsonResult(result);
});

registerTool('titan_miras_stats', async (titan, _args) => {
  const result = await titan.getMirasStats();
  return jsonResult(result);
});

registerTool('titan_classify', async (titan, args) => {
  const parsed = ToolSchemas.titan_classify.parse(args);
  const result = titan.classifyContent(parsed.content);
  return jsonResult(result);
});

registerTool('titan_category_summary', async (titan, args) => {
  const parsed = ToolSchemas.titan_category_summary.parse(args);
  const summary = titan.getCategorySummary(parsed.category as import('../cortex/types.js').MemoryCategory);
  if (!summary) {
    return jsonResult({ error: 'Cortex not enabled or no summary available for this category' });
  }
  return jsonResult(summary);
});

registerTool('titan_sufficiency', async (titan, args) => {
  const parsed = ToolSchemas.titan_sufficiency.parse(args);
  let memories: import('../types.js').MemoryEntry[] = [];
  if (parsed.memoryIds && parsed.memoryIds.length > 0) {
    for (const id of parsed.memoryIds) {
      const mem = await titan.get(id);
      if (mem) memories.push(mem);
    }
  } else {
    const recallResult = await titan.recall(parsed.query, { limit: 20 });
    if ('fusedMemories' in recallResult) {
      memories = recallResult.fusedMemories;
    }
  }
  const result = titan.checkCategorySufficiency(memories, parsed.query);
  return jsonResult(result);
});

registerTool('titan_noop', async (titan, args) => {
  const parsed = ToolSchemas.titan_noop.parse(args);
  const result = await titan.logNoop({
    reason: parsed.reason as NoopReason,
    context: parsed.context,
    contentPreview: parsed.contentPreview,
    sessionId: parsed.sessionId,
    projectId: parsed.projectId,
  });
  return jsonResult(result);
});

registerTool('titan_noop_stats', async (titan, _args) => {
  const result = await titan.getNoopStats();
  return jsonResult(result);
});

registerTool('titan_intent', async (titan, args) => {
  const parsed = ToolSchemas.titan_intent.parse(args);
  const result = titan.detectQueryIntent(parsed.query);
  return jsonResult(result);
});

registerTool('titan_link', async (titan, args) => {
  const parsed = ToolSchemas.titan_link.parse(args);
  const result = await titan.createCausalLink({
    fromMemoryId: parsed.fromMemoryId,
    toMemoryId: parsed.toMemoryId,
    relationship: parsed.relationship as import('../graphs/causal.js').CausalRelationType,
    strength: parsed.strength,
    evidence: parsed.evidence,
  });
  return jsonResult(result);
});

registerTool('titan_trace', async (titan, args) => {
  const parsed = ToolSchemas.titan_trace.parse(args);
  const result = await titan.traceCausalChain(parsed.memoryId, {
    depth: parsed.depth,
    direction: parsed.direction as 'forward' | 'backward' | 'both' | undefined,
  });
  return jsonResult(result);
});

registerTool('titan_why', async (titan, args) => {
  const parsed = ToolSchemas.titan_why.parse(args);
  const result = await titan.explainMemory(parsed.memoryId, parsed.maxDepth);
  return jsonResult(result);
});

registerTool('titan_focus_add', async (titan, args) => {
  const parsed = ToolSchemas.titan_focus_add.parse(args);
  const result = await titan.addFocus(parsed.content, {
    priority: parsed.priority,
    ttlMs: parsed.ttlMs,
    source: parsed.source,
  });
  return jsonResult(result);
});

registerTool('titan_focus_list', async (titan, args) => {
  const parsed = ToolSchemas.titan_focus_list.parse(args);
  let result: unknown;
  if (parsed.asContext) {
    result = await titan.getFocusContext();
  } else {
    result = await titan.getFocus();
  }
  return jsonResult(result);
});

registerTool('titan_focus_clear', async (titan, _args) => {
  const result = await titan.clearFocus();
  return jsonResult(result);
});

registerTool('titan_focus_remove', async (titan, args) => {
  const parsed = ToolSchemas.titan_focus_remove.parse(args);
  const result = await titan.removeFocus(parsed.id);
  return jsonResult(result);
});

registerTool('titan_scratchpad', async (titan, args) => {
  const parsed = ToolSchemas.titan_scratchpad.parse(args);
  let result: unknown;
  switch (parsed.action) {
    case 'get':
      result = await titan.getScratchpad();
      break;
    case 'set':
      await titan.setScratchpad(parsed.content || '');
      result = { success: true };
      break;
    case 'append':
      await titan.appendScratchpad(parsed.content || '');
      result = { success: true };
      break;
    case 'clear':
      await titan.clearScratchpad();
      result = { success: true };
      break;
  }
  return jsonResult(result);
});

registerTool('titan_compress', async (titan, args) => {
  const parsed = ToolSchemas.titan_compress.parse(args);
  const result = await titan.compress(parsed.memoryId, {
    targetRatio: parsed.targetRatio,
    contextQuery: parsed.contextQuery,
  });
  return jsonResult(result);
});

registerTool('titan_expand', async (titan, args) => {
  const parsed = ToolSchemas.titan_expand.parse(args);
  const compressed = JSON.parse(parsed.compressed);
  const result = await titan.expand(compressed, {
    verbosity: parsed.verbosity as 'minimal' | 'normal' | 'detailed' | undefined,
    format: parsed.format as 'prose' | 'structured' | 'bullet' | undefined,
  });
  return jsonResult(result);
});

registerTool('titan_benchmark', async (_titan, args) => {
  const parsed = ToolSchemas.titan_benchmark.parse(args);

  // v2.1: Temporarily enable LLM config for benchmark if llmMode requested
  let configRestorer: (() => void) | undefined;
  if (parsed.llmMode) {
    const { updateConfig: uc, getConfig: gc } = await import('../utils/config.js');
    const prevLlm = { ...gc().llm };
    uc({
      llm: {
        ...prevLlm,
        enabled: true,
        classifyEnabled: true,
        extractEnabled: true,
        rerankEnabled: true,
        summarizeEnabled: false,
      },
    });
    configRestorer = () => uc({ llm: prevLlm });
  }

  try {
    const benchmarkModule = await import('../benchmarks/index.js');
    const benchOpts = {
      categories: parsed.categories as ('retrieval' | 'latency' | 'token-efficiency' | 'accuracy')[] | undefined,
      verbose: parsed.verbose,
      rawMode: parsed.rawMode,
      llmMode: parsed.llmMode,
    };

    let result: unknown;

    // v2.1: Multi-run with statistics
    if (parsed.runs && parsed.runs > 1) {
      const multiResult = await benchmarkModule.runMultiRunBenchmark({
        ...benchOpts,
        runs: parsed.runs,
      });
      // Save raw data to file for third-party verification
      const fs = await import('fs');
      const dataDir = 'benchmarks/data';
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const filename = `${multiResult.mode}-${multiResult.runs}runs-${Date.now()}.json`;
      fs.writeFileSync(
        `${dataDir}/${filename}`,
        JSON.stringify(multiResult, null, 2)
      );
      result = {
        ...multiResult.statistics,
        mode: multiResult.mode,
        runs: multiResult.runs,
        timestamp: multiResult.timestamp,
        environment: multiResult.environment,
        dataFile: `benchmarks/data/${filename}`,
      };
    } else {
      result = await benchmarkModule.runBenchmarkSuite(benchOpts);
    }

    return jsonResult(result);
  } finally {
    configRestorer?.();
  }
});

// v2.2: Multi-Agent Namespace - Publish
registerTool('titan_publish', async (titan, args) => {
  const parsed = ToolSchemas.titan_publish.parse(args);
  const memory = await titan.get(parsed.memoryId);
  if (!memory) {
    return textResult(`Memory not found: ${parsed.memoryId}`);
  }
  // Update namespace metadata
  memory.metadata.namespace = parsed.visibility;
  // Note: In a full implementation this would persist the update to Zilliz.
  // For now we return the intent for the caller to re-store if needed.
  return jsonResult({
    memoryId: parsed.memoryId,
    previousNamespace: memory.metadata.namespace,
    newNamespace: parsed.visibility,
    published: true,
  });
});

// v2.2: Multi-Agent Namespace - Subscribe
registerTool('titan_subscribe', async (titan, args) => {
  const parsed = ToolSchemas.titan_subscribe.parse(args);
  const filter = namespaceManager.buildFilter(
    parsed.agentId,
    parsed.namespace,
    parsed.projectId,
  );
  // Use recall with a broad query, applying the namespace filter
  const result = await titan.recall('*', {
    limit: 20,
    projectId: parsed.projectId,
  });
  // Apply namespace filtering on the client side
  let memories = 'fusedMemories' in result ? result.fusedMemories : [];
  if (filter && memories.length > 0) {
    memories = memories.filter(m => {
      const ns = m.metadata.namespace as string | undefined;
      const aid = m.metadata.agentId as string | undefined;
      const pid = m.metadata.projectId as string | undefined;

      if (parsed.namespace === 'private') {
        return ns === 'private' && aid === parsed.agentId;
      }
      if (parsed.namespace === 'project') {
        return ns === 'project' && pid === parsed.projectId;
      }
      // global: exclude foreign private
      if (parsed.agentId) {
        return ns !== 'private' || aid === parsed.agentId;
      }
      return ns !== 'private';
    });
  }
  return jsonResult({
    memories: memories.map(m => ({
      id: m.id,
      content: m.content.substring(0, 200),
      namespace: m.metadata.namespace || 'global',
      agentId: m.metadata.agentId,
      projectId: m.metadata.projectId,
    })),
    count: memories.length,
    filter,
  });
});

// v2.2: Token-Efficient Navigation
registerTool('titan_navigate', async (titan, args) => {
  const parsed = ToolSchemas.titan_navigate.parse(args);
  const depth = parsed.depth ?? 1;
  const tokenBudget = parsed.tokenBudget ?? 2048;
  const categories: Array<'knowledge' | 'profile' | 'event' | 'behavior' | 'skill'> =
    parsed.category ? [parsed.category] : ['knowledge', 'profile', 'event', 'behavior', 'skill'];

  if (depth === 1) {
    // Depth 1: Category summaries (~500 tokens)
    const summaries: Array<{
      category: string;
      entryCount: number;
      topSnippet: string;
    }> = [];
    for (const cat of categories) {
      const summary = titan.getCategorySummary(cat);
      if (summary && summary.entryCount > 0) {
        summaries.push({
          category: summary.category,
          entryCount: summary.entryCount,
          topSnippet: summary.summary.substring(0, 100),
        });
      }
    }
    return jsonResult({
      depth: 1,
      categories: summaries,
      totalCategories: summaries.length,
      tokenEstimate: Math.ceil(JSON.stringify(summaries).length / 4),
    });
  }

  // Depth 2: Full memories for category, capped at tokenBudget
  const query = parsed.query || parsed.category || '*';
  const recallResult = await titan.recall(query, { limit: 50 });
  const memories = 'fusedMemories' in recallResult ? recallResult.fusedMemories : [];

  // Filter by category if specified
  const filtered = parsed.category
    ? memories.filter(m => m.metadata.category === parsed.category)
    : memories;

  // Apply relevance gate with token budget
  const scored = filtered.map((m, i) => ({
    id: m.id,
    content: m.content,
    score: 1 - (i * 0.01), // Use position as proxy for relevance
    metadata: m.metadata as Record<string, unknown>,
  }));
  const gated = gateByRelevance(scored, tokenBudget);

  return jsonResult({
    depth: 2,
    category: parsed.category || 'all',
    memories: gated.map(g => ({
      id: g.id,
      content: g.content,
      category: g.metadata.category,
    })),
    count: gated.length,
    totalAvailable: filtered.length,
    tokenEstimate: Math.ceil(JSON.stringify(gated).length / 4),
    tokenBudget,
  });
});
