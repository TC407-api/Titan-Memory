/**
 * Tests for src/mcp/discovery.ts
 * Covers createDiscoveryRouter and getResourceMetadata.
 */

import { createDiscoveryRouter, getResourceMetadata, DiscoveryConfig, ExtendedResourceMetadata } from '../src/mcp/discovery';
import { AllScopes } from '../src/mcp/auth/scopes';
import { Router } from 'express';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return {
    resourceId: 'https://titan-memory.example.api',
    auth0Domain: 'example.auth0.com',
    serverVersion: '2.1.0',
    documentationUrl: 'https://docs.example.com',
    ...overrides,
  };
}

/** Minimal mock for express Request/Response — enough for route handlers. */
function makeMockRes() {
  const res = {
    _json: undefined as unknown,
    json(data: unknown) {
      this._json = data;
      return this;
    },
  };
  return res;
}

function makeMockReq() {
  return {} as any;
}

/**
 * Extract route handlers registered on an Express Router by path.
 * Works by duck-typing the router's internal stack.
 */
function getRouteHandler(router: Router, routePath: string): ((req: any, res: any) => void) | undefined {
  const stack = (router as any).stack as Array<{
    route?: { path: string; stack: Array<{ handle: (req: any, res: any) => void }> };
  }>;
  for (const layer of stack) {
    if (layer.route?.path === routePath) {
      return layer.route.stack[0]?.handle;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// getResourceMetadata
// ---------------------------------------------------------------------------

describe('getResourceMetadata', () => {
  it('should return the resource identifier from config', () => {
    const meta = getResourceMetadata(makeConfig());
    expect(meta.resource).toBe('https://titan-memory.example.api');
  });

  it('should build authorization_servers from auth0Domain', () => {
    const meta = getResourceMetadata(makeConfig({ auth0Domain: 'myapp.eu.auth0.com' }));
    expect(meta.authorization_servers).toContain('https://myapp.eu.auth0.com/');
  });

  it('should expose exactly one authorization server', () => {
    const meta = getResourceMetadata(makeConfig());
    expect(meta.authorization_servers.length).toBe(1);
  });

  it('should include all scopes from AllScopes', () => {
    const meta = getResourceMetadata(makeConfig());
    for (const scope of AllScopes) {
      expect(meta.scopes_supported).toContain(scope);
    }
  });

  it('should support header as bearer method', () => {
    const meta = getResourceMetadata(makeConfig());
    expect(meta.bearer_methods_supported).toContain('header');
  });

  it('should use provided documentationUrl', () => {
    const meta = getResourceMetadata(makeConfig({ documentationUrl: 'https://my-docs.io' }));
    expect(meta.resource_documentation).toBe('https://my-docs.io');
  });

  it('should fall back to default GitHub URL when documentationUrl is omitted', () => {
    const meta = getResourceMetadata(makeConfig({ documentationUrl: undefined }));
    expect(meta.resource_documentation).toContain('github.com');
  });

  it('should embed mcp_server with correct name', () => {
    const meta = getResourceMetadata(makeConfig());
    expect(meta.mcp_server.name).toBe('titan-memory');
  });

  it('should embed mcp_server with provided serverVersion', () => {
    const meta = getResourceMetadata(makeConfig({ serverVersion: '3.0.0' }));
    expect(meta.mcp_server.version).toBe('3.0.0');
  });

  it('should default serverVersion to 1.0.0 when omitted', () => {
    const meta = getResourceMetadata(makeConfig({ serverVersion: undefined }));
    expect(meta.mcp_server.version).toBe('1.0.0');
  });

  it('should embed mcp_server transport as streamable-http', () => {
    const meta = getResourceMetadata(makeConfig());
    expect(meta.mcp_server.transport).toBe('streamable-http');
  });

  it('should include scope_descriptions for each scope', () => {
    const meta = getResourceMetadata(makeConfig());
    expect(typeof meta.scope_descriptions).toBe('object');
    expect(Object.keys(meta.scope_descriptions).length).toBeGreaterThan(0);
  });

  it('should be a pure function — two calls return equal (not same) objects', () => {
    const config = makeConfig();
    const first = getResourceMetadata(config);
    const second = getResourceMetadata(config);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// createDiscoveryRouter
// ---------------------------------------------------------------------------

describe('createDiscoveryRouter', () => {
  it('should return an Express Router', () => {
    const router = createDiscoveryRouter(makeConfig());
    expect(typeof router).toBe('function');
  });

  it('should register GET /oauth-protected-resource route', () => {
    const router = createDiscoveryRouter(makeConfig());
    const handler = getRouteHandler(router, '/oauth-protected-resource');
    expect(handler).toBeDefined();
  });

  it('should register GET /mcp-server route', () => {
    const router = createDiscoveryRouter(makeConfig());
    const handler = getRouteHandler(router, '/mcp-server');
    expect(handler).toBeDefined();
  });

  describe('/oauth-protected-resource handler', () => {
    it('should respond with resource metadata as JSON', () => {
      const router = createDiscoveryRouter(makeConfig());
      const handler = getRouteHandler(router, '/oauth-protected-resource')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as ExtendedResourceMetadata;
      expect(json.resource).toBe('https://titan-memory.example.api');
    });

    it('should include authorization_servers in the response', () => {
      const router = createDiscoveryRouter(makeConfig());
      const handler = getRouteHandler(router, '/oauth-protected-resource')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as ExtendedResourceMetadata;
      expect(Array.isArray(json.authorization_servers)).toBe(true);
      expect(json.authorization_servers.length).toBeGreaterThan(0);
    });

    it('should include scopes_supported in the response', () => {
      const router = createDiscoveryRouter(makeConfig());
      const handler = getRouteHandler(router, '/oauth-protected-resource')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as ExtendedResourceMetadata;
      expect(Array.isArray(json.scopes_supported)).toBe(true);
      expect(json.scopes_supported.length).toBeGreaterThan(0);
    });

    it('should reflect custom resourceId from config', () => {
      const router = createDiscoveryRouter(makeConfig({ resourceId: 'https://custom.resource' }));
      const handler = getRouteHandler(router, '/oauth-protected-resource')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as ExtendedResourceMetadata;
      expect(json.resource).toBe('https://custom.resource');
    });
  });

  describe('/mcp-server handler', () => {
    it('should respond with extended metadata including tool_scopes', () => {
      const router = createDiscoveryRouter(makeConfig());
      const handler = getRouteHandler(router, '/mcp-server')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as ExtendedResourceMetadata & { tool_scopes: Record<string, string[]> };
      expect(json.tool_scopes).toBeDefined();
      expect(typeof json.tool_scopes).toBe('object');
    });

    it('should include titan_recall in tool_scopes', () => {
      const router = createDiscoveryRouter(makeConfig());
      const handler = getRouteHandler(router, '/mcp-server')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as { tool_scopes: Record<string, string[]> };
      expect(json.tool_scopes.titan_recall).toContain('memory:read');
    });

    it('should include titan_add in tool_scopes with write scope', () => {
      const router = createDiscoveryRouter(makeConfig());
      const handler = getRouteHandler(router, '/mcp-server')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as { tool_scopes: Record<string, string[]> };
      expect(json.tool_scopes.titan_add).toContain('memory:write');
    });

    it('should include titan_flush with admin scope', () => {
      const router = createDiscoveryRouter(makeConfig());
      const handler = getRouteHandler(router, '/mcp-server')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as { tool_scopes: Record<string, string[]> };
      expect(json.tool_scopes.titan_flush).toContain('memory:admin');
    });

    it('should still include all base metadata fields', () => {
      const router = createDiscoveryRouter(makeConfig());
      const handler = getRouteHandler(router, '/mcp-server')!;
      const res = makeMockRes();

      handler(makeMockReq(), res);

      const json = res._json as ExtendedResourceMetadata;
      expect(json.resource).toBeDefined();
      expect(json.scopes_supported).toBeDefined();
      expect(json.mcp_server).toBeDefined();
    });
  });
});
