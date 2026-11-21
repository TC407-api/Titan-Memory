/**
 * Characterization tests for the MCP tool input schemas (src/mcp/tools.ts).
 *
 * They pin what each schema's parse() returns, so a zod upgrade cannot
 * silently change the arguments that reach the tool handlers. In particular,
 * an omitted optional field must stay undefined: the handlers pass these
 * values straight into prune, recall, suggest and benchmark, which apply
 * their own defaults.
 */

import { ToolSchemas } from '../src/mcp/tools';

type ToolName = keyof typeof ToolSchemas;

// Smallest valid input for every tool: only the required fields.
const MINIMAL_ARGS: Record<ToolName, Record<string, unknown>> = {
  titan_add: { content: 'c' },
  titan_recall: { query: 'q' },
  titan_get: { id: 'm1' },
  titan_delete: { id: 'm1' },
  titan_stats: {},
  titan_flush: {},
  titan_curate: { content: 'c' },
  titan_today: {},
  titan_prune: {},
  titan_feedback: { id: 'm1', signal: 'helpful' },
  titan_suggest: { context: 'ctx' },
  titan_patterns: { query: 'q' },
  titan_miras_stats: {},
  titan_classify: { content: 'c' },
  titan_category_summary: { category: 'skill' },
  titan_sufficiency: { query: 'q' },
  titan_noop: { reason: 'routine' },
  titan_noop_stats: {},
  titan_intent: { query: 'q' },
  titan_link: { fromMemoryId: 'a', toMemoryId: 'b', relationship: 'causes' },
  titan_trace: { memoryId: 'm1' },
  titan_why: { memoryId: 'm1' },
  titan_focus_add: { content: 'c' },
  titan_focus_list: {},
  titan_focus_clear: {},
  titan_focus_remove: { id: 'f1' },
  titan_scratchpad: { action: 'get' },
  titan_compress: { memoryId: 'm1' },
  titan_expand: { compressed: '{}' },
  titan_benchmark: {},
  titan_publish: { memoryId: 'm1', visibility: 'global' },
  titan_subscribe: {},
  titan_navigate: {},
};

const TOOL_NAMES = Object.keys(MINIMAL_ARGS) as ToolName[];

function parseTool(name: ToolName, args: unknown): Record<string, unknown> {
  return ToolSchemas[name].parse(args) as Record<string, unknown>;
}

function isRejected(name: ToolName, args: unknown): boolean {
  return !ToolSchemas[name].safeParse(args).success;
}

describe('MCP tool schemas: fixture coverage', () => {
  it('has a minimal fixture for every exported schema', () => {
    expect(Object.keys(ToolSchemas).sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe('MCP tool schemas: omitted optional fields stay undefined', () => {
  it.each(TOOL_NAMES)('%s parses minimal args to exactly those args', (name) => {
    expect(parseTool(name, MINIMAL_ARGS[name])).toStrictEqual(MINIMAL_ARGS[name]);
  });

  it('titan_prune does not inject thresholds or dryRun', () => {
    const parsed = parseTool('titan_prune', {});
    expect(parsed.decayThreshold).toBeUndefined();
    expect(parsed.utilityThreshold).toBeUndefined();
    expect(parsed.dryRun).toBeUndefined();
  });

  it('titan_recall does not inject limit or mode', () => {
    const parsed = parseTool('titan_recall', { query: 'q' });
    expect('limit' in parsed).toBe(false);
    expect('mode' in parsed).toBe(false);
  });

  it('titan_navigate leaves depth and tokenBudget to the handler', () => {
    const parsed = parseTool('titan_navigate', {});
    expect(parsed.depth).toBeUndefined();
    expect(parsed.tokenBudget).toBeUndefined();
  });
});

describe('MCP tool schemas: supplied values pass through', () => {
  it('keeps every titan_benchmark field as given', () => {
    const args = {
      categories: ['retrieval', 'latency'],
      verbose: true,
      llmMode: false,
      rawMode: true,
      runs: 3,
    };
    expect(parseTool('titan_benchmark', args)).toStrictEqual(args);
  });

  it('keeps every titan_prune field as given', () => {
    const args = { decayThreshold: 0.1, dryRun: true, utilityThreshold: 0.2 };
    expect(parseTool('titan_prune', args)).toStrictEqual(args);
  });

  it('strips keys that are not in the schema', () => {
    expect(parseTool('titan_get', { id: 'm1', extra: 1 })).toStrictEqual({ id: 'm1' });
  });
});

describe('MCP tool schemas: invalid input is rejected', () => {
  it.each([
    ['titan_add', { content: 'c', layer: 1 }],
    ['titan_add', { content: 'c', layer: 6 }],
    ['titan_link', { fromMemoryId: 'a', toMemoryId: 'b', relationship: 'causes', strength: -0.1 }],
    ['titan_link', { fromMemoryId: 'a', toMemoryId: 'b', relationship: 'causes', strength: 1.1 }],
    ['titan_benchmark', { runs: 0 }],
    ['titan_benchmark', { runs: 11 }],
    ['titan_navigate', { depth: 0 }],
    ['titan_navigate', { depth: 3 }],
  ] as Array<[ToolName, unknown]>)('%s rejects out-of-range %j', (name, args) => {
    expect(isRejected(name, args)).toBe(true);
  });

  it.each([
    ['titan_add', {}],
    ['titan_add', { content: 'c', layer: '3' }],
    ['titan_feedback', { id: 'm1', signal: 'neutral' }],
    ['titan_scratchpad', { action: 'delete' }],
    ['titan_benchmark', { categories: ['speed'] }],
    ['titan_recall', { query: 'q', limit: null }],
  ] as Array<[ToolName, unknown]>)('%s rejects malformed %j', (name, args) => {
    expect(isRejected(name, args)).toBe(true);
  });

  it('accepts the range boundaries', () => {
    expect(isRejected('titan_add', { content: 'c', layer: 2 })).toBe(false);
    expect(isRejected('titan_add', { content: 'c', layer: 5 })).toBe(false);
    expect(isRejected('titan_benchmark', { runs: 10 })).toBe(false);
    expect(isRejected('titan_navigate', { depth: 2 })).toBe(false);
  });
});
