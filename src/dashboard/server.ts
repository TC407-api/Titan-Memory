/**
 * Titan Memory Web Dashboard Server
 * Express HTTP server with REST endpoints for memory visualization
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import { TitanMemory, initTitan, initTitanForProject } from '../titan.js';
import { DashboardWebSocket } from './websocket.js';
import { createApiRouter } from './api.js';
import {
  initAuth,
  getAuthConfig,
  validateDashboardToken,
  shouldBypassAuth,
  isAllowedOrigin,
  type AuthConfig,
} from '../utils/auth.js';
import { applySecurityHeaders, type SecurityConfig } from './middleware/security.js';

export interface DashboardConfig {
  port: number;
  host: string;
  projectId?: string;
  corsOrigins?: string[];
  /** Authentication configuration */
  auth?: Partial<AuthConfig>;
  /** Security headers configuration */
  security?: Partial<SecurityConfig>;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private wsServer: DashboardWebSocket | null = null;
  private titan: TitanMemory | null = null;
  private config: DashboardConfig;
  private staticDir: string;

  constructor(config: Partial<DashboardConfig> = {}) {
    this.config = {
      port: config.port || 3939,
      host: config.host || '127.0.0.1',
      projectId: config.projectId,
      // Default to localhost only - more secure default
      corsOrigins: config.corsOrigins || ['http://localhost:3939', 'http://127.0.0.1:3939'],
    };
    // Initialize authentication
    if (config.auth) {
      initAuth(config.auth);
    }
    // Resolve static directory relative to this file's location in dist
    this.staticDir = path.resolve(__dirname, 'static');
  }

  /**
   * Get the TitanMemory instance
   */
  getTitan(): TitanMemory | null {
    return this.titan;
  }

  /**
   * Emit event to all connected WebSocket clients
   */
  emitEvent(event: string, data: unknown): void {
    this.wsServer?.broadcast({ event, data, timestamp: new Date().toISOString() });
  }

  /**
   * Start the dashboard server
   */
  async start(): Promise<void> {
    // Initialize TitanMemory
    if (this.config.projectId) {
      this.titan = await initTitanForProject(this.config.projectId);
    } else {
      this.titan = await initTitan();
    }

    // Create HTTP server with request handler
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    // Create WebSocket server
    this.wsServer = new DashboardWebSocket(this.server);

    // Start listening
    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        console.log(`Titan Memory Dashboard running at http://${this.config.host}:${this.config.port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  /**
   * Stop the dashboard server
   */
  async stop(): Promise<void> {
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          resolve();
        });
      });
    }

    if (this.titan) {
      await this.titan.close();
      this.titan = null;
    }
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const origin = req.headers.origin;
    const authConfig = getAuthConfig();
    const host = req.headers.host || 'localhost';

    // Apply security headers (CSP, X-Frame-Options, etc.)
    applySecurityHeaders(res, this.config.security, host);

    // Set CORS headers - validate origin against whitelist
    const allowedOrigin = isAllowedOrigin(origin, this.config.corsOrigins || [])
      ? origin
      : this.config.corsOrigins?.[0] || '';

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${authConfig.tokenHeader}`);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // API routes require authentication
      if (pathname.startsWith('/api/')) {
        // Check authentication
        const remoteAddress = req.socket.remoteAddress;
        const token = req.headers[authConfig.tokenHeader.toLowerCase()] as string | undefined;

        if (!shouldBypassAuth(remoteAddress) && !validateDashboardToken(token)) {
          this.sendJson(res, 401, { error: 'Unauthorized', message: 'Valid API token required' });
          return;
        }

        await this.handleApiRequest(req, res, pathname, url);
        return;
      }

      // Static file serving (no auth required for UI)
      await this.serveStatic(pathname, res);
    } catch (error) {
      console.error('Request error:', error);
      this.sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  /**
   * Handle API requests
   */
  private async handleApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    url: URL
  ): Promise<void> {
    if (!this.titan) {
      this.sendJson(res, 503, { error: 'TitanMemory not initialized' });
      return;
    }

    const method = req.method || 'GET';
    const body = method === 'POST' ? await this.parseBody(req) : null;

    // Route API requests
    const router = createApiRouter(this.titan, this);

    const route = router.find(r => r.method === method && this.matchPath(pathname, r.path));
    if (route) {
      const params = this.extractParams(pathname, route.path);
      const query = Object.fromEntries(url.searchParams);
      try {
        const result = await route.handler({ params, query, body });
        this.sendJson(res, 200, result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.sendJson(res, 400, { error: message });
      }
      return;
    }

    this.sendJson(res, 404, { error: 'API endpoint not found' });
  }

  /**
   * Serve static files
   */
  private async serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    // Default to index.html
    if (pathname === '/') {
      pathname = '/index.html';
    }

    const filePath = path.join(this.staticDir, pathname);

    // Security: ensure path is within static directory
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(this.staticDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Check if file exists
    try {
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Determine content type
      const ext = path.extname(resolvedPath).toLowerCase();
      const contentTypes: Record<string, string> = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      const contentType = contentTypes[ext] || 'application/octet-stream';

      // Read and send file
      const content = await fs.promises.readFile(resolvedPath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  /**
   * Parse request body as JSON
   */
  private parseBody(req: http.IncomingMessage): Promise<unknown> {
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB
    return new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large (max 1MB)'));
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send JSON response
   */
  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Match path pattern (supports :param placeholders)
   */
  private matchPath(pathname: string, pattern: string): boolean {
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');

    if (patternParts.length !== pathParts.length) return false;

    return patternParts.every((part, i) => {
      if (part.startsWith(':')) return true;
      return part === pathParts[i];
    });
  }

  /**
   * Extract path parameters
   */
  private extractParams(pathname: string, pattern: string): Record<string, string> {
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    const params: Record<string, string> = {};

    patternParts.forEach((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = pathParts[i];
      }
    });

    return params;
  }
}

/**
 * Start dashboard from CLI
 */
export async function startDashboard(options: Partial<DashboardConfig> = {}): Promise<DashboardServer> {
  const server = new DashboardServer(options);
  await server.start();
  return server;
}
