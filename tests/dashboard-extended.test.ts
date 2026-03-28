/**
 * Extended Dashboard Tests
 * Covers WebSocket auth, rate limiting, CSP headers, body size rejection,
 * and security middleware in isolation.
 */

import http from 'http';
import { EventEmitter } from 'events';
import { applySecurityHeaders, createSecurityMiddleware, getProductionSecurityConfig, getDevelopmentSecurityConfig } from '../src/dashboard/middleware/security.js';
import { checkRateLimit } from '../src/dashboard/middleware/rate-limit.js';
import { DashboardWebSocket } from '../src/dashboard/websocket.js';

// ---- Mock auth module ----
const mockValidateDashboardToken = jest.fn();
const mockShouldBypassAuth = jest.fn();

jest.mock('../src/utils/auth.js', () => ({
  initAuth: jest.fn(),
  getAuthConfig: jest.fn(() => ({
    enabled: true,
    dashboardTokens: ['valid-token-123'],
    a2aTokens: [],
    tokenHeader: 'X-Titan-Token',
    allowLocalhostWithoutAuth: true,
  })),
  validateDashboardToken: (...args: unknown[]) => mockValidateDashboardToken(...args),
  shouldBypassAuth: (...args: unknown[]) => mockShouldBypassAuth(...args),
  isAllowedOrigin: jest.fn(() => true),
}));

// ---- Mock WebSocket helpers ----

const WS_OPEN = 1;
const WS_CLOSED = 3;

class MockWs extends EventEmitter {
  readyState = WS_OPEN;
  sent: string[] = [];
  closeCode?: number;
  closeReason?: string;

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = WS_CLOSED;
  }

  lastParsed(): any {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

// ---- Mock ServerResponse ----

class MockResponse {
  statusCode = 200;
  headers: Record<string, string | number> = {};
  body = '';
  ended = false;

  setHeader(name: string, value: string | number) {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string): string | number | undefined {
    return this.headers[name.toLowerCase()];
  }

  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
  }

  end(data?: string) {
    if (data) this.body = data;
    this.ended = true;
  }
}

// ---- Mock IncomingMessage ----

function makeReq(overrides: Partial<{
  remoteAddress: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  contentLength: string;
}> = {}): http.IncomingMessage {
  const req = new EventEmitter() as any;
  req.socket = { remoteAddress: overrides.remoteAddress || '192.168.1.100' };
  req.url = overrides.url || '/';
  req.method = overrides.method || 'GET';
  req.headers = overrides.headers || {};
  if (overrides.contentLength) {
    req.headers['content-length'] = overrides.contentLength;
  }
  req.destroy = jest.fn();
  return req as http.IncomingMessage;
}

// ==================== Security Headers Tests ====================

describe('Security Middleware - applySecurityHeaders', () => {
  it('should set all required security headers', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, {}, 'localhost:3939');

    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-xss-protection']).toBe('1; mode=block');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['permissions-policy']).toBeDefined();
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('should include localhost WebSocket sources in CSP for localhost host', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, {}, 'localhost:3939');

    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('ws://localhost:*');
    expect(csp).toContain('ws://127.0.0.1:*');
  });

  it('should use wss for non-localhost hosts in CSP', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, {}, 'example.com');

    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('wss://*');
    expect(csp).not.toContain('ws://localhost');
  });

  it('should set HSTS header when enabled', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, { enableHsts: true, hstsMaxAge: 31536000 }, 'example.com');

    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['strict-transport-security']).toContain('includeSubDomains');
    expect(res.headers['strict-transport-security']).toContain('preload');
  });

  it('should NOT set HSTS header when disabled (default)', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, {}, 'localhost');

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('should use Content-Security-Policy-Report-Only when cspReportOnly is true', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, { cspReportOnly: true }, 'localhost');

    expect(res.headers['content-security-policy-report-only']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('should include additional script sources in CSP', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, { additionalScriptSources: ['https://custom.cdn.com'] }, 'localhost');

    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('https://custom.cdn.com');
  });

  it('should include additional connect sources in CSP', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, { additionalConnectSources: ['https://api.example.com'] }, 'localhost');

    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('https://api.example.com');
  });

  it('should restrict object-src, frame-ancestors, base-uri in CSP', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, {}, 'localhost');

    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('should deny browser features via Permissions-Policy', () => {
    const res = new MockResponse() as any;
    applySecurityHeaders(res, {}, 'localhost');

    const pp = res.headers['permissions-policy'] as string;
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('payment=()');
  });
});

describe('Security Middleware - createSecurityMiddleware', () => {
  it('should return a function that applies headers', () => {
    const middleware = createSecurityMiddleware({});
    expect(typeof middleware).toBe('function');

    const req = makeReq({ headers: { host: 'localhost:3939' } });
    const res = new MockResponse() as any;
    middleware(req, res);

    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('Security config presets', () => {
  it('getProductionSecurityConfig should enable HSTS', () => {
    const config = getProductionSecurityConfig();
    expect(config.enableHsts).toBe(true);
    expect(config.cspReportOnly).toBe(false);
  });

  it('getDevelopmentSecurityConfig should use report-only CSP', () => {
    const config = getDevelopmentSecurityConfig();
    expect(config.enableHsts).toBe(false);
    expect(config.cspReportOnly).toBe(true);
  });
});

// ==================== Rate Limiting Tests ====================

describe('Rate Limiting - checkRateLimit', () => {
  it('should allow requests under the limit', () => {
    const req = makeReq({ remoteAddress: '10.0.0.1' });
    const res = new MockResponse() as any;

    const allowed = checkRateLimit(req, res, { windowMs: 60000, maxRequests: 100 });
    expect(allowed).toBe(true);
    expect(res.headers['x-ratelimit-limit']).toBe(100);
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('should return 429 after exceeding the threshold', () => {
    const uniqueIp = `10.99.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

    // Exhaust the limit
    for (let i = 0; i <= 5; i++) {
      const req = makeReq({ remoteAddress: uniqueIp });
      const res = new MockResponse() as any;
      checkRateLimit(req, res, { windowMs: 60000, maxRequests: 5 });
    }

    // Next request should be rate limited
    const req = makeReq({ remoteAddress: uniqueIp });
    const res = new MockResponse() as any;
    const allowed = checkRateLimit(req, res, { windowMs: 60000, maxRequests: 5 });

    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('Too many requests');
  });

  it('should set rate limit headers on every response', () => {
    const req = makeReq({ remoteAddress: '10.0.0.50' });
    const res = new MockResponse() as any;
    checkRateLimit(req, res, { windowMs: 60000, maxRequests: 100 });

    expect(res.headers['x-ratelimit-limit']).toBe(100);
    expect(typeof res.headers['x-ratelimit-remaining']).toBe('number');
  });

  it('should track requests per IP independently', () => {
    const ip1 = `10.1.${Math.floor(Math.random() * 255)}.1`;
    const ip2 = `10.2.${Math.floor(Math.random() * 255)}.2`;

    // Exhaust IP1
    for (let i = 0; i <= 3; i++) {
      const req = makeReq({ remoteAddress: ip1 });
      const res = new MockResponse() as any;
      checkRateLimit(req, res, { windowMs: 60000, maxRequests: 3 });
    }

    // IP2 should still be allowed
    const req2 = makeReq({ remoteAddress: ip2 });
    const res2 = new MockResponse() as any;
    const allowed = checkRateLimit(req2, res2, { windowMs: 60000, maxRequests: 3 });
    expect(allowed).toBe(true);
  });
});

// ==================== WebSocket Auth Tests ====================

describe('DashboardWebSocket - Connection Auth', () => {
  let httpServer: http.Server;
  let dashWs: DashboardWebSocket;

  beforeEach((done) => {
    httpServer = http.createServer();
    httpServer.listen(0, '127.0.0.1', () => {
      dashWs = new DashboardWebSocket(httpServer);
      done();
    });
  });

  afterEach((done) => {
    dashWs.close();
    httpServer.close(done);
  });

  it('should reject connection without token from non-localhost', () => {
    mockShouldBypassAuth.mockReturnValue(false);
    mockValidateDashboardToken.mockReturnValue(false);

    const ws = new MockWs();
    const req = makeReq({
      remoteAddress: '192.168.1.100',
      url: '/ws',
      headers: { host: '192.168.1.100:3939' },
    });

    // Trigger the connection handler directly
    (dashWs as any).handleConnection(ws, req);

    expect(ws.closeCode).toBe(1008);
    expect(ws.closeReason).toBe('Unauthorized');
  });

  it('should accept connection with valid token in query string', () => {
    mockShouldBypassAuth.mockReturnValue(false);
    mockValidateDashboardToken.mockReturnValue(true);

    const ws = new MockWs();
    const req = makeReq({
      remoteAddress: '192.168.1.100',
      url: '/ws?token=valid-token-123',
      headers: { host: '192.168.1.100:3939' },
    });

    (dashWs as any).handleConnection(ws, req);

    // Should NOT have been closed
    expect(ws.closeCode).toBeUndefined();
    // Should have received a welcome message
    expect(ws.sent.length).toBeGreaterThan(0);
    const welcome = ws.lastParsed();
    expect(welcome.event).toBe('connected');
  });

  it('should accept connection with valid Bearer token in header', () => {
    mockShouldBypassAuth.mockReturnValue(false);
    mockValidateDashboardToken.mockReturnValue(true);

    const ws = new MockWs();
    const req = makeReq({
      remoteAddress: '192.168.1.100',
      url: '/ws',
      headers: {
        host: '192.168.1.100:3939',
        authorization: 'Bearer valid-token-123',
      },
    });

    (dashWs as any).handleConnection(ws, req);

    expect(ws.closeCode).toBeUndefined();
    expect(ws.sent.length).toBeGreaterThan(0);
  });

  it('should bypass auth for localhost connections', () => {
    mockShouldBypassAuth.mockReturnValue(true);
    mockValidateDashboardToken.mockClear();

    const ws = new MockWs();
    const req = makeReq({
      remoteAddress: '127.0.0.1',
      url: '/ws',
      headers: { host: 'localhost:3939' },
    });

    (dashWs as any).handleConnection(ws, req);

    // Should NOT be closed
    expect(ws.closeCode).toBeUndefined();
    expect(ws.sent.length).toBeGreaterThan(0);
    // Should NOT have called validateDashboardToken at all
    expect(mockValidateDashboardToken).not.toHaveBeenCalled();
  });
});

// ==================== WebSocket Message Handling Tests ====================

describe('DashboardWebSocket - Message Handling', () => {
  let httpServer: http.Server;
  let dashWs: DashboardWebSocket;

  beforeEach((done) => {
    mockShouldBypassAuth.mockReturnValue(true);
    httpServer = http.createServer();
    httpServer.listen(0, '127.0.0.1', () => {
      dashWs = new DashboardWebSocket(httpServer);
      done();
    });
  });

  afterEach((done) => {
    dashWs.close();
    httpServer.close(done);
  });

  it('should respond to ping with pong', () => {
    const ws = new MockWs();
    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });
    (dashWs as any).handleConnection(ws, req);

    // Simulate ping message
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));

    const messages = ws.sent.map(s => JSON.parse(s));
    const pong = messages.find((m: any) => m.event === 'pong');
    expect(pong).toBeDefined();
  });

  it('should acknowledge subscribe messages', () => {
    const ws = new MockWs();
    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });
    (dashWs as any).handleConnection(ws, req);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', data: { events: ['memory.*'] } })));

    const messages = ws.sent.map(s => JSON.parse(s));
    const subAck = messages.find((m: any) => m.event === 'subscribed');
    expect(subAck).toBeDefined();
  });

  it('should echo unknown message types', () => {
    const ws = new MockWs();
    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });
    (dashWs as any).handleConnection(ws, req);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'unknown', data: 'test' })));

    const messages = ws.sent.map(s => JSON.parse(s));
    const echo = messages.find((m: any) => m.event === 'echo');
    expect(echo).toBeDefined();
    expect(echo.data).toEqual({ type: 'unknown', data: 'test' });
  });

  it('should handle invalid JSON gracefully', () => {
    const ws = new MockWs();
    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });
    (dashWs as any).handleConnection(ws, req);

    // Send invalid JSON - should not throw or crash
    ws.emit('message', Buffer.from('not json at all'));

    // Server should still be functioning
    expect(dashWs.getClientCount()).toBe(1);
  });

  it('should remove client on close', () => {
    const ws = new MockWs();
    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });
    (dashWs as any).handleConnection(ws, req);

    expect(dashWs.getClientCount()).toBe(1);

    ws.emit('close');

    expect(dashWs.getClientCount()).toBe(0);
  });

  it('should remove client on error', () => {
    const ws = new MockWs();
    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });
    (dashWs as any).handleConnection(ws, req);

    expect(dashWs.getClientCount()).toBe(1);

    ws.emit('error', new Error('test error'));

    expect(dashWs.getClientCount()).toBe(0);
  });
});

// ==================== Broadcast Tests ====================

describe('DashboardWebSocket - Broadcast', () => {
  let httpServer: http.Server;
  let dashWs: DashboardWebSocket;

  beforeEach((done) => {
    mockShouldBypassAuth.mockReturnValue(true);
    httpServer = http.createServer();
    httpServer.listen(0, '127.0.0.1', () => {
      dashWs = new DashboardWebSocket(httpServer);
      done();
    });
  });

  afterEach((done) => {
    dashWs.close();
    httpServer.close(done);
  });

  it('should broadcast to all connected clients', () => {
    const ws1 = new MockWs();
    const ws2 = new MockWs();

    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });
    (dashWs as any).handleConnection(ws1, req);
    (dashWs as any).handleConnection(ws2, req);

    expect(dashWs.getClientCount()).toBe(2);

    dashWs.broadcast({
      event: 'test-broadcast',
      data: { msg: 'hello all' },
      timestamp: new Date().toISOString(),
    });

    // Both clients should receive the broadcast (on top of their welcome messages)
    const ws1Messages = ws1.sent.map(s => JSON.parse(s));
    const ws2Messages = ws2.sent.map(s => JSON.parse(s));

    expect(ws1Messages.find((m: any) => m.event === 'test-broadcast')).toBeDefined();
    expect(ws2Messages.find((m: any) => m.event === 'test-broadcast')).toBeDefined();
  });

  it('should skip closed connections during broadcast', () => {
    const ws1 = new MockWs();
    const ws2 = new MockWs();
    ws2.readyState = WS_CLOSED;

    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });
    (dashWs as any).handleConnection(ws1, req);
    // Manually add ws2 to clients to test the broadcast skip
    (dashWs as any).clients.add(ws2);

    const beforeCount = ws2.sent.length;

    dashWs.broadcast({
      event: 'test',
      data: {},
      timestamp: new Date().toISOString(),
    });

    // ws2 should NOT have received the message
    expect(ws2.sent.length).toBe(beforeCount);
  });
});

// ==================== DashboardWebSocket close() Tests ====================

describe('DashboardWebSocket - close()', () => {
  let httpServer: http.Server;
  let dashWs: DashboardWebSocket;

  beforeEach((done) => {
    mockShouldBypassAuth.mockReturnValue(true);
    httpServer = http.createServer();
    httpServer.listen(0, '127.0.0.1', () => {
      dashWs = new DashboardWebSocket(httpServer);
      done();
    });
  });

  afterEach((done) => {
    httpServer.close(done);
  });

  it('should close all client connections and clear state', () => {
    const ws1 = new MockWs();
    const ws2 = new MockWs();
    const req = makeReq({ remoteAddress: '127.0.0.1', url: '/ws' });

    (dashWs as any).handleConnection(ws1, req);
    (dashWs as any).handleConnection(ws2, req);

    expect(dashWs.getClientCount()).toBe(2);

    dashWs.close();

    expect(dashWs.getClientCount()).toBe(0);
    expect(ws1.closeCode).toBe(1000);
    expect(ws2.closeCode).toBe(1000);
  });
});

// ==================== Body Size Rejection (DashboardServer.parseBody) ====================

describe('DashboardServer - Body Size Rejection', () => {
  // We test parseBody by importing the class and calling the private method
  // via a workaround (construct server, access private method)
  const { DashboardServer } = require('../src/dashboard/server');

  it('should reject body when Content-Length exceeds 1MB', async () => {
    const server = new DashboardServer({ port: 0 });
    const req = makeReq({ contentLength: '2000000' }); // 2MB

    await expect(
      (server as any).parseBody(req)
    ).rejects.toThrow('Request body too large');
  });

  it('should reject body when streaming data exceeds 1MB', async () => {
    const server = new DashboardServer({ port: 0 });
    const req = makeReq({});

    const promise = (server as any).parseBody(req);

    // Stream more than 1MB of data
    const chunk = Buffer.alloc(600000, 'a');
    req.emit('data', chunk);
    req.emit('data', chunk); // Total: 1.2MB

    await expect(promise).rejects.toThrow('Request body too large');
  });

  it('should parse valid JSON body', async () => {
    const server = new DashboardServer({ port: 0 });
    const req = makeReq({});

    const promise = (server as any).parseBody(req);

    req.emit('data', Buffer.from('{"key": "value"}'));
    req.emit('end');

    const result = await promise;
    expect(result).toEqual({ key: 'value' });
  });

  it('should reject invalid JSON body', async () => {
    const server = new DashboardServer({ port: 0 });
    const req = makeReq({});

    const promise = (server as any).parseBody(req);

    req.emit('data', Buffer.from('not json'));
    req.emit('end');

    await expect(promise).rejects.toThrow('Invalid JSON body');
  });

  it('should return null for empty body', async () => {
    const server = new DashboardServer({ port: 0 });
    const req = makeReq({});

    const promise = (server as any).parseBody(req);
    req.emit('end');

    const result = await promise;
    expect(result).toBeNull();
  });
});

// ==================== Path Matching Tests ====================

describe('DashboardServer - Path Matching', () => {
  const { DashboardServer } = require('../src/dashboard/server');
  const server = new DashboardServer({ port: 0 });

  it('should match exact paths', () => {
    expect((server as any).matchPath('/api/health', '/api/health')).toBe(true);
    expect((server as any).matchPath('/api/health', '/api/stats')).toBe(false);
  });

  it('should match paths with parameters', () => {
    expect((server as any).matchPath('/api/memories/abc-123', '/api/memories/:id')).toBe(true);
    expect((server as any).matchPath('/api/memories', '/api/memories/:id')).toBe(false);
  });

  it('should extract path parameters', () => {
    const params = (server as any).extractParams('/api/memories/abc-123', '/api/memories/:id');
    expect(params).toEqual({ id: 'abc-123' });
  });

  it('should reject paths with different segment counts', () => {
    expect((server as any).matchPath('/api/a/b/c', '/api/a/b')).toBe(false);
  });
});
