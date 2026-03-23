/**
 * HTTP Transport Server for Titan Memory MCP
 * Provides OAuth 2.1 secured HTTP endpoint for MCP protocol
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { IncomingMessage } from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ToolDefinitions, ToolHandler } from './tools.js';
import { Auth0Verifier, VerifiedToken } from './auth/auth0-verifier.js';
import { createAuthMiddleware, AuthenticatedRequest } from './auth/middleware.js';
import { createDiscoveryRouter } from './discovery.js';
import { hasRequiredScopes } from './auth/scopes.js';
import { isLocalhost } from '../utils/auth.js';

const SERVER_NAME = 'titan-memory';
const SERVER_VERSION = '1.0.0';

/**
 * HTTP server configuration
 */
export interface HttpServerConfig {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** Auth0 domain for OAuth */
  auth0Domain?: string;
  /** Auth0 audience for token validation */
  auth0Audience?: string;
  /** Allow localhost without auth (default: true in dev, false in prod) */
  allowLocalhostBypass?: boolean;
  /** Enable audit logging (default: true) */
  enableAuditLog?: boolean;
}

/**
 * Map to store transports by session ID
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Shared tool handler across all sessions
 */
let toolHandler: ToolHandler | null = null;

/**
 * Get or create the shared tool handler
 */
function getToolHandler(): ToolHandler {
  if (!toolHandler) {
    toolHandler = new ToolHandler();
  }
  return toolHandler;
}

/**
 * Create and configure the MCP Server instance
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const handler = getToolHandler();

  // Handle tools/list request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ToolDefinitions,
    };
  });

  // Handle tools/call request
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handler.handleToolCall(name, args as Record<string, unknown>);
  });

  return server;
}

/**
 * Create Express application with OAuth middleware
 */
export function createHttpApp(config: HttpServerConfig = {}): Express {
  const {
    auth0Domain = process.env.AUTH0_DOMAIN,
    auth0Audience = process.env.AUTH0_AUDIENCE || 'https://titan-memory.api',
    allowLocalhostBypass = process.env.NODE_ENV !== 'production',
    enableAuditLog = true,
  } = config;

  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Health check endpoint (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION });
  });

  // Discovery endpoints (no auth required)
  if (auth0Domain) {
    app.use('/.well-known', createDiscoveryRouter({
      resourceId: auth0Audience,
      auth0Domain,
      serverVersion: SERVER_VERSION,
    }));
  }

  // Auth middleware for /mcp endpoint
  let authMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | null = null;

  if (auth0Domain && auth0Audience) {
    const verifier = new Auth0Verifier({
      domain: auth0Domain,
      audience: auth0Audience,
    });

    authMiddleware = createAuthMiddleware({
      verifier,
      allowLocalhostBypass,
      enableAuditLog,
    }) as (req: Request, res: Response, next: NextFunction) => void;

    console.error(`[titan-memory] OAuth enabled with Auth0 domain: ${auth0Domain}`);
    console.error(`[titan-memory] Localhost bypass: ${allowLocalhostBypass ? 'enabled' : 'disabled'}`);
  } else {
    console.error(`[titan-memory] WARNING: OAuth not configured. Set AUTH0_DOMAIN and AUTH0_AUDIENCE.`);

    // If no OAuth configured but localhost bypass is allowed, permit localhost
    if (allowLocalhostBypass) {
      authMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        const remoteAddress = req.ip || req.socket.remoteAddress;
        if (isLocalhost(remoteAddress)) {
          req.auth = { token: null as unknown as VerifiedToken, bypassed: true };
          next();
        } else {
          res.status(401).json({
            error: 'Unauthorized',
            message: 'OAuth not configured and request is not from localhost',
          });
        }
      };
    }
  }

  // Fail-closed: refuse to start without any authentication mode
  if (!authMiddleware) {
    console.error('[titan-memory] FATAL: No authentication mode configured. Set AUTH0_DOMAIN + AUTH0_AUDIENCE, or enable allowLocalhostBypass.');
    console.error('[titan-memory] The server will respond 503 to all /mcp requests until auth is configured.');

    // Return a degraded server that responds 503 instead of crashing the process
    app.use('/mcp', (_req: Request, res: Response) => {
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'No authentication mode configured. Set AUTH0_DOMAIN + AUTH0_AUDIENCE, or enable allowLocalhostBypass.',
      });
    });
    return app;
  }

  // MCP endpoint with auth
  app.use('/mcp', authMiddleware);

  // Handle POST /mcp - MCP protocol messages
  app.post('/mcp', async (req: AuthenticatedRequest, res: Response) => {
    try {
      // Tool-level scope enforcement
      if (req.body?.method === 'tools/call' && req.body?.params?.name) {
        const toolName = req.body.params.name;
        const permissions = req.auth?.token?.scopes ?? [];
        if (!req.auth?.bypassed && !hasRequiredScopes(toolName, permissions)) {
          res.status(403).json({
            jsonrpc: '2.0', id: req.body.id,
            error: { code: -32600, message: `Insufficient scopes for tool: ${toolName}` },
          });
          return;
        }
      }

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        // Reuse existing transport
        transport = transports.get(sessionId)!;
      } else {
        // Create new transport for new session
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        // Create and connect server
        const server = createMcpServer();
        await server.connect(transport);

        // Store transport for session reuse
        const newSessionId = transport.sessionId;
        if (newSessionId) {
          transports.set(newSessionId, transport);

          // Cleanup on transport close
          transport.onclose = () => {
            transports.delete(newSessionId);
          };
        }
      }

      // Convert our auth format to MCP SDK's AuthInfo format
      const mcpReq = req as IncomingMessage & { auth?: AuthInfo };
      if (req.auth && !req.auth.bypassed && req.auth.token) {
        mcpReq.auth = {
          token: '', // Token string not needed after validation
          clientId: req.auth.token.sub,
          scopes: req.auth.token.scopes,
          expiresAt: req.auth.token.exp,
        };
      }

      // Handle the request with auth info
      await transport.handleRequest(mcpReq, res, req.body);
    } catch (error) {
      console.error('[titan-memory] MCP request error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  // Handle GET /mcp - SSE stream for server-initiated messages
  app.get('/mcp', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid session ID. Initialize session with POST first.',
      });
      return;
    }

    const transport = transports.get(sessionId)!;
    const mcpReq = req as IncomingMessage & { auth?: AuthInfo };
    if (req.auth && !req.auth.bypassed && req.auth.token) {
      mcpReq.auth = {
        token: '',
        clientId: req.auth.token.sub,
        scopes: req.auth.token.scopes,
        expiresAt: req.auth.token.exp,
      };
    }
    await transport.handleRequest(mcpReq, res);
  });

  // Handle DELETE /mcp - Close session
  app.delete('/mcp', async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.close();
      transports.delete(sessionId);
      res.status(204).send();
    } else {
      res.status(404).json({
        error: 'Not Found',
        message: 'Session not found',
      });
    }
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startHttpServer(config: HttpServerConfig = {}): Promise<void> {
  const { port = parseInt(process.env.TITAN_HTTP_PORT || '3000', 10), host = '127.0.0.1' } = config;

  const app = createHttpApp(config);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.error(`[titan-memory] HTTP server started on http://${host}:${port}`);
      console.error(`[titan-memory] MCP endpoint: http://${host}:${port}/mcp`);
      console.error(`[titan-memory] Discovery: http://${host}:${port}/.well-known/oauth-protected-resource`);
      resolve();
    });

    server.on('error', (error) => {
      console.error(`[titan-memory] HTTP server error:`, error);
      reject(error);
    });

    // Graceful shutdown
    const cleanup = async () => {
      console.error('[titan-memory] Shutting down HTTP server...');

      // Close all transports
      for (const [sessionId, transport] of transports) {
        await transport.close();
        transports.delete(sessionId);
      }

      // Close tool handler
      if (toolHandler) {
        await toolHandler.close();
        toolHandler = null;
      }

      server.close(() => {
        console.error('[titan-memory] HTTP server closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}

/**
 * Get active session count (for monitoring)
 */
export function getActiveSessionCount(): number {
  return transports.size;
}
