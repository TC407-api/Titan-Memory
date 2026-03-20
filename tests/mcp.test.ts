/**
 * Titan Memory MCP Server Tests
 */

import { ToolHandler, ToolDefinitions } from '../src/mcp/tools';

describe('MCP Tool Definitions', () => {
  it('should have 30 tools defined', () => {
    expect(ToolDefinitions).toHaveLength(30);
  });

  it('should have correct tool names', () => {
    const toolNames = ToolDefinitions.map(t => t.name);
    expect(toolNames).toContain('titan_add');
    expect(toolNames).toContain('titan_recall');
    expect(toolNames).toContain('titan_get');
    expect(toolNames).toContain('titan_delete');
    expect(toolNames).toContain('titan_stats');
    expect(toolNames).toContain('titan_flush');
    expect(toolNames).toContain('titan_curate');
    expect(toolNames).toContain('titan_today');
    expect(toolNames).toContain('titan_prune');
    expect(toolNames).toContain('titan_feedback'); // FR-1: Utility tracking
    // MIRAS Enhancement tools
    expect(toolNames).toContain('titan_suggest');
    expect(toolNames).toContain('titan_patterns');
    expect(toolNames).toContain('titan_miras_stats');
    // Cortex tools
    expect(toolNames).toContain('titan_classify');
    expect(toolNames).toContain('titan_category_summary');
    expect(toolNames).toContain('titan_sufficiency');
    // v2.0 tools - NOOP and Intent
    expect(toolNames).toContain('titan_noop');
    expect(toolNames).toContain('titan_noop_stats');
    expect(toolNames).toContain('titan_intent');
    // v2.0 tools - Causal Graph
    expect(toolNames).toContain('titan_link');
    expect(toolNames).toContain('titan_trace');
    expect(toolNames).toContain('titan_why');
    // v2.0 tools - Working Memory
    expect(toolNames).toContain('titan_focus_add');
    expect(toolNames).toContain('titan_focus_list');
    expect(toolNames).toContain('titan_focus_clear');
    expect(toolNames).toContain('titan_focus_remove');
    expect(toolNames).toContain('titan_scratchpad');
    // v2.0 tools - Compression
    expect(toolNames).toContain('titan_compress');
    expect(toolNames).toContain('titan_expand');
    // v2.0 tools - Benchmark
    expect(toolNames).toContain('titan_benchmark');
  });

  it('should have required fields in tool definitions', () => {
    for (const tool of ToolDefinitions) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool.inputSchema).toHaveProperty('type', 'object');
      expect(tool.inputSchema).toHaveProperty('properties');
      expect(tool.inputSchema).toHaveProperty('required');
    }
  });

  it('titan_add should require content', () => {
    const addTool = ToolDefinitions.find(t => t.name === 'titan_add');
    expect(addTool?.inputSchema.required).toContain('content');
  });

  it('titan_recall should require query', () => {
    const recallTool = ToolDefinitions.find(t => t.name === 'titan_recall');
    expect(recallTool?.inputSchema.required).toContain('query');
  });
});

describe('ToolHandler', () => {
  // Recall tests hit Zilliz Cloud which can be slow
  jest.setTimeout(30000);
  let handler: ToolHandler;

  beforeEach(() => {
    handler = new ToolHandler();
  });

  afterEach(async () => {
    await handler.close();
  });

  it('should handle unknown tool gracefully', async () => {
    const result = await handler.handleToolCall('unknown_tool', {});
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('should handle titan_stats', async () => {
    const result = await handler.handleToolCall('titan_stats', {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('totalMemories');
    expect(parsed).toHaveProperty('byLayer');
  });

  it('should handle titan_add with content', async () => {
    const result = await handler.handleToolCall('titan_add', {
      content: 'Test memory from MCP',
      tags: ['test', 'mcp'],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('id');
    expect(parsed).toHaveProperty('content', 'Test memory from MCP');
  });

  it('should handle titan_recall with query', async () => {
    // First add a memory
    await handler.handleToolCall('titan_add', {
      content: 'MCP recall test memory',
    });

    const result = await handler.handleToolCall('titan_recall', {
      query: 'MCP recall test',
      limit: 5,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('fusedMemories');
    expect(parsed).toHaveProperty('totalQueryTimeMs');
  });

  it('should handle titan_today', async () => {
    const result = await handler.handleToolCall('titan_today', {});
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('should handle titan_prune with dryRun', async () => {
    const result = await handler.handleToolCall('titan_prune', {
      dryRun: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('dryRun', true);
  });

  it('should handle validation errors', async () => {
    const result = await handler.handleToolCall('titan_add', {});
    expect(result.content[0].text).toContain('Error');
  });

  it('should handle titan_get for non-existent memory', async () => {
    const result = await handler.handleToolCall('titan_get', {
      id: 'non-existent-id',
    });
    expect(result.content[0].text).toContain('Memory not found');
  });
});
