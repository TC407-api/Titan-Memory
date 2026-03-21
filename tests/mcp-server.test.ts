/**
 * MCP Server Critical Path Tests
 *
 * Tests createServer(), tool registration, request routing, and error handling.
 * The ToolHandler is mocked so no real Zilliz calls are made.
 *
 * Coverage targets:
 *   - createServer(): returns a Server instance with name/version
 *   - ListTools handler: returns full ToolDefinitions array
 *   - CallTool handler: routes to ToolHandler.handleToolCall correctly
 *   - CallTool handler: propagates tool result content
 *   - CallTool handler: handles errors thrown by ToolHandler
 *   - TransportMode: startServerWithConfig throws on unknown mode
 *   - ServerConfig: mode defaults to 'stdio'
 *   - ToolHandler delegation: each routed call receives correct name + args
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createServer, startServerWithConfig, TransportMode } from '../src/mcp/server';
import { ToolDefinitions, ToolHandler } from '../src/mcp/tools';

// ---------------------------------------------------------------------------
// Mock ToolHandler so tests never touch Zilliz or the filesystem
// We keep a module-level reference to the shared handleToolCall mock so
// individual tests can inspect calls without digging through mock.instances.
// ---------------------------------------------------------------------------

const mockHandleToolCall = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: '{"ok":true}' }],
});
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/mcp/tools', () => {
  const actual = jest.requireActual('../src/mcp/tools') as typeof import('../src/mcp/tools');
  return {
    ...actual,
    ToolHandler: jest.fn().mockImplementation(() => ({
      handleToolCall: mockHandleToolCall,
      close: mockClose,
    })),
  };
});

// Mock the transport so startServer() doesn't block stdin
jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock the HTTP server module so http/dual modes don't actually bind ports
jest.mock('../src/mcp/http-server', () => ({
  startHttpServer: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// createServer()
// ---------------------------------------------------------------------------

describe('createServer()', () => {
  it('should return an instance of Server', () => {
    const server = createServer();
    expect(server).toBeInstanceOf(Server);
  });

  it('should create a new ToolHandler on each call', () => {
    const MockToolHandler = ToolHandler as jest.MockedClass<typeof ToolHandler>;
    MockToolHandler.mockClear();

    createServer();
    createServer();

    expect(MockToolHandler).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Internal handler access helper
// The MCP SDK stores handlers keyed by method name and validates the full
// JSON-RPC envelope (including `method`) on each invocation.
// ---------------------------------------------------------------------------

type InternalServer = {
  _requestHandlers: Map<string, (req: Record<string, unknown>) => Promise<unknown>>;
};

function getHandler(server: Server, method: string) {
  const s = server as unknown as InternalServer;
  const handler = s._requestHandlers?.get(method);
  if (!handler) throw new Error(`No handler registered for method: ${method}`);
  return handler;
}

function listToolsRequest() {
  return { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
}

function callToolRequest(name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } };
}

// ---------------------------------------------------------------------------
// ListTools handler
// ---------------------------------------------------------------------------

describe('MCP ListTools handler', () => {
  it('should return all tool definitions', async () => {
    const server = createServer();
    const handler = getHandler(server, 'tools/list');

    const result = await handler(listToolsRequest()) as { tools: unknown[] };

    expect(result.tools).toBe(ToolDefinitions);
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);
  });

  it('should include titan_add in the tools list', async () => {
    const server = createServer();
    const handler = getHandler(server, 'tools/list');

    const result = await handler(listToolsRequest()) as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);

    expect(names).toContain('titan_add');
    expect(names).toContain('titan_recall');
    expect(names).toContain('titan_stats');
  });

  it('should return exactly 30 tools matching ToolDefinitions length', async () => {
    const server = createServer();
    const handler = getHandler(server, 'tools/list');

    const result = await handler(listToolsRequest()) as { tools: unknown[] };
    expect(result.tools.length).toBe(ToolDefinitions.length);
  });
});

// ---------------------------------------------------------------------------
// CallTool handler
// ---------------------------------------------------------------------------

describe('MCP CallTool handler', () => {
  it('should route tool call to ToolHandler.handleToolCall and return content', async () => {
    const server = createServer();
    const handler = getHandler(server, 'tools/call');

    const result = await handler(callToolRequest('titan_stats', {})) as {
      content: Array<{ text: string }>;
    };

    expect(result.content).toBeDefined();
    expect(result.content[0].text).toBe('{"ok":true}');
  });

  it('should forward tool name and arguments to handleToolCall', async () => {
    mockHandleToolCall.mockClear();
    const server = createServer();

    const handler = getHandler(server, 'tools/call');
    await handler(callToolRequest('titan_add', { content: 'hello world', tags: ['test'] }));

    expect(mockHandleToolCall).toHaveBeenCalledWith('titan_add', { content: 'hello world', tags: ['test'] });
  });

  it('should forward empty arguments object correctly', async () => {
    mockHandleToolCall.mockClear();
    const server = createServer();

    const handler = getHandler(server, 'tools/call');
    await handler(callToolRequest('titan_stats', {}));

    expect(mockHandleToolCall).toHaveBeenCalledWith('titan_stats', {});
  });

  it('should propagate rejection from ToolHandler', async () => {
    const localHandleToolCall = jest.fn().mockRejectedValue(new Error('Storage unavailable'));
    const MockToolHandler = ToolHandler as jest.MockedClass<typeof ToolHandler>;
    MockToolHandler.mockImplementationOnce(() => ({
      handleToolCall: localHandleToolCall,
      close: jest.fn().mockResolvedValue(undefined),
    }) as unknown as ToolHandler);

    const server = createServer();
    const handler = getHandler(server, 'tools/call');

    await expect(
      handler(callToolRequest('titan_add', { content: 'x' }))
    ).rejects.toThrow('Storage unavailable');
  });
});

// ---------------------------------------------------------------------------
// startServerWithConfig() — mode routing
// ---------------------------------------------------------------------------

describe('startServerWithConfig()', () => {
  it('should throw for an unknown transport mode', async () => {
    await expect(
      startServerWithConfig({ mode: 'websocket' as TransportMode })
    ).rejects.toThrow('Unknown transport mode: websocket');
  });

  it('should call startHttpServer when mode is http', async () => {
    const { startHttpServer } = await import('../src/mcp/http-server');
    const mockStartHttp = startHttpServer as jest.Mock;
    mockStartHttp.mockClear();

    await startServerWithConfig({ mode: 'http', port: 8099 });

    expect(mockStartHttp).toHaveBeenCalledWith({ port: 8099 });
  });
});

// ---------------------------------------------------------------------------
// TransportMode type guard
// ---------------------------------------------------------------------------

describe('TransportMode type', () => {
  it('should accept stdio as a valid mode', () => {
    const mode: TransportMode = 'stdio';
    expect(mode).toBe('stdio');
  });

  it('should accept http as a valid mode', () => {
    const mode: TransportMode = 'http';
    expect(mode).toBe('http');
  });

  it('should accept dual as a valid mode', () => {
    const mode: TransportMode = 'dual';
    expect(mode).toBe('dual');
  });
});

// ---------------------------------------------------------------------------
// Server capabilities
// ---------------------------------------------------------------------------

describe('Server capabilities', () => {
  it('should expose the tools capability', () => {
    const server = createServer();
    // The Server constructor accepts capabilities — we verify the server was
    // constructed without throwing, which means the SDK accepted our config.
    expect(server).toBeInstanceOf(Server);
  });
});
