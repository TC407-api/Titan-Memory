import { createAuthMiddleware, createScopeMiddleware, extractBearerToken, checkToolAccess, AuthenticatedRequest } from '../src/mcp/auth/middleware.js';
import { Auth0Verifier, TokenVerificationError, VerifiedToken } from '../src/mcp/auth/auth0-verifier.js';
import { Response, NextFunction } from 'express';

// Mock dependencies
jest.mock('../src/mcp/auth/auth0-verifier.js');
jest.mock('../src/mcp/auth/scopes.js', () => ({
  hasRequiredScopes: jest.fn((tool: string, scopes: string[]) => scopes.includes('admin') || scopes.includes(`read:${tool}`)),
  getRequiredScopes: jest.fn((tool: string) => [`read:${tool}`]),
}));
jest.mock('../src/utils/auth.js', () => ({
  isLocalhost: jest.fn((addr: string | undefined) => addr === '127.0.0.1' || addr === '::1'),
}));

function mockReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    ip: '1.2.3.4',
    socket: { remoteAddress: '1.2.3.4' },
    headers: {},
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('extractBearerToken', () => {
  it('should return null for undefined header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('should return null for non-bearer header', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull();
  });

  it('should return null for malformed header', () => {
    expect(extractBearerToken('BearerTokenNoSpace')).toBeNull();
  });

  it('should return null for header with extra parts', () => {
    expect(extractBearerToken('Bearer token extra')).toBeNull();
  });

  it('should extract token from valid Bearer header', () => {
    expect(extractBearerToken('Bearer my-jwt-token')).toBe('my-jwt-token');
  });

  it('should be case-insensitive for Bearer prefix', () => {
    expect(extractBearerToken('bearer my-token')).toBe('my-token');
  });
});

describe('createAuthMiddleware', () => {
  let verifier: jest.Mocked<Auth0Verifier>;
  let next: NextFunction;

  beforeEach(() => {
    verifier = new Auth0Verifier({ domain: 'test.auth0.com', audience: 'aud' }) as jest.Mocked<Auth0Verifier>;
    next = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should bypass auth for localhost when allowLocalhostBypass is true', async () => {
    const middleware = createAuthMiddleware({ verifier, allowLocalhostBypass: true });
    const req = mockReq({ ip: '127.0.0.1' });
    const res = mockRes();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.auth?.bypassed).toBe(true);
  });

  it('should not bypass for non-localhost even with allowLocalhostBypass', async () => {
    const middleware = createAuthMiddleware({ verifier, allowLocalhostBypass: true });
    const req = mockReq({ ip: '1.2.3.4', headers: {} });
    const res = mockRes();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 401 when no Authorization header', async () => {
    const middleware = createAuthMiddleware({ verifier });
    const req = mockReq();
    const res = mockRes();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should set auth on request for valid token', async () => {
    const token: VerifiedToken = {
      sub: 'user1', scopes: ['read:all'], iss: 'https://test.auth0.com/',
      aud: 'aud', exp: 9999999999, iat: 1000000000, claims: {},
    };
    verifier.verify = jest.fn().mockResolvedValue(token);

    const middleware = createAuthMiddleware({ verifier });
    const req = mockReq({ headers: { authorization: 'Bearer valid-jwt' } });
    const res = mockRes();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.auth?.token).toEqual(token);
    expect(req.auth?.bypassed).toBe(false);
  });

  it('should return 401 for TokenVerificationError', async () => {
    verifier.verify = jest.fn().mockRejectedValue(new TokenVerificationError('expired', 'EXPIRED'));

    const middleware = createAuthMiddleware({ verifier });
    const req = mockReq({ headers: { authorization: 'Bearer expired-jwt' } });
    const res = mockRes();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 for generic errors', async () => {
    verifier.verify = jest.fn().mockRejectedValue(new Error('network down'));

    const middleware = createAuthMiddleware({ verifier });
    const req = mockReq({ headers: { authorization: 'Bearer bad' } });
    const res = mockRes();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should suppress audit log when enableAuditLog is false', async () => {
    const middleware = createAuthMiddleware({ verifier, enableAuditLog: false });
    const req = mockReq();
    const res = mockRes();

    await middleware(req, res, next);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('createScopeMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should allow bypassed auth', () => {
    const scopeCheck = createScopeMiddleware()('titan_recall');
    const req = mockReq();
    req.auth = { token: null as unknown as VerifiedToken, bypassed: true };
    const res = mockRes();

    scopeCheck(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should return 401 when no auth info', () => {
    const scopeCheck = createScopeMiddleware()('titan_recall');
    const req = mockReq();
    const res = mockRes();

    scopeCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 403 when scopes are insufficient', () => {
    const scopeCheck = createScopeMiddleware()('titan_recall');
    const req = mockReq();
    req.auth = {
      token: { sub: 'u', scopes: ['write:other'], iss: '', aud: '', exp: 0, iat: 0, claims: {} },
      bypassed: false,
    };
    const res = mockRes();

    scopeCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should allow when scopes match', () => {
    const scopeCheck = createScopeMiddleware()('titan_recall');
    const req = mockReq();
    req.auth = {
      token: { sub: 'u', scopes: ['read:titan_recall'], iss: '', aud: '', exp: 0, iat: 0, claims: {} },
      bypassed: false,
    };
    const res = mockRes();

    scopeCheck(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('checkToolAccess', () => {
  it('should allow bypassed auth', () => {
    const result = checkToolAccess({ token: null as unknown as VerifiedToken, bypassed: true }, 'tool');
    expect(result.allowed).toBe(true);
  });

  it('should deny when no auth', () => {
    const result = checkToolAccess(undefined, 'tool');
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Authentication required');
  });

  it('should deny when scopes insufficient', () => {
    const auth = {
      token: { sub: 'u', scopes: ['wrong'], iss: '', aud: '', exp: 0, iat: 0, claims: {} },
      bypassed: false,
    };
    const result = checkToolAccess(auth, 'tool');
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Missing required scopes');
  });

  it('should allow when scopes match', () => {
    const auth = {
      token: { sub: 'u', scopes: ['admin'], iss: '', aud: '', exp: 0, iat: 0, claims: {} },
      bypassed: false,
    };
    const result = checkToolAccess(auth, 'tool');
    expect(result.allowed).toBe(true);
  });
});
