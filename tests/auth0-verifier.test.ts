import { Auth0Verifier, TokenVerificationError, createAuth0VerifierFromEnv } from '../src/mcp/auth/auth0-verifier.js';
import * as jose from 'jose';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  errors: {
    JWTExpired: class JWTExpired extends Error { name = 'JWTExpired'; },
    JWSSignatureVerificationFailed: class JWSSignatureVerificationFailed extends Error { name = 'JWSSignatureVerificationFailed'; },
    JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error { name = 'JWTClaimValidationFailed'; },
  },
}));

describe('Auth0Verifier', () => {
  let verifier: Auth0Verifier;

  beforeEach(() => {
    jest.clearAllMocks();
    verifier = new Auth0Verifier({
      domain: 'test.auth0.com',
      audience: 'https://api.test.com',
    });
  });

  describe('constructor', () => {
    it('should use default jwksCacheTtl when not provided', () => {
      const v = new Auth0Verifier({ domain: 'x.auth0.com', audience: 'aud' });
      expect(v.getIssuer()).toBe('https://x.auth0.com/');
    });

    it('should use custom jwksCacheTtl when provided', () => {
      const v = new Auth0Verifier({ domain: 'x.auth0.com', audience: 'aud', jwksCacheTtl: 5000 });
      expect(v.getAudience()).toBe('aud');
    });
  });

  describe('verify', () => {
    it('should throw MISSING_TOKEN for empty token', async () => {
      await expect(verifier.verify('')).rejects.toThrow(TokenVerificationError);
      await expect(verifier.verify('')).rejects.toMatchObject({ code: 'MISSING_TOKEN' });
    });

    it('should verify a valid token and extract scopes from scope claim', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
        payload: {
          sub: 'user123',
          iss: 'https://test.auth0.com/',
          aud: 'https://api.test.com',
          exp: 9999999999,
          iat: 1000000000,
          scope: 'read:memories write:memories',
        },
      });

      const result = await verifier.verify('valid-token');
      expect(result.sub).toBe('user123');
      expect(result.scopes).toContain('read:memories');
      expect(result.scopes).toContain('write:memories');
      expect(result.exp).toBe(9999999999);
    });

    it('should extract scopes from permissions claim (array)', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
        payload: {
          sub: 'client456',
          iss: 'https://test.auth0.com/',
          aud: 'https://api.test.com',
          exp: 9999999999,
          iat: 1000000000,
          permissions: ['admin', 'read:all'],
        },
      });

      const result = await verifier.verify('valid-token');
      expect(result.scopes).toContain('admin');
      expect(result.scopes).toContain('read:all');
    });

    it('should merge scope and permissions claims', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
        payload: {
          sub: 'user',
          scope: 'read:memories',
          permissions: ['write:memories'],
          exp: 9999999999,
          iat: 1000000000,
        },
      });

      const result = await verifier.verify('token');
      expect(result.scopes).toContain('read:memories');
      expect(result.scopes).toContain('write:memories');
    });

    it('should handle empty scope string', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
        payload: { sub: 'user', scope: '', exp: 1, iat: 1 },
      });
      const result = await verifier.verify('token');
      expect(result.scopes).toEqual([]);
    });

    it('should handle non-string items in permissions array', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
        payload: { sub: 'user', permissions: ['valid', 123, null], exp: 1, iat: 1 },
      });
      const result = await verifier.verify('token');
      expect(result.scopes).toEqual(['valid']);
    });

    it('should use defaults when payload fields are missing', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValueOnce({
        payload: {},
      });
      const result = await verifier.verify('token');
      expect(result.sub).toBe('');
      expect(result.exp).toBe(0);
      expect(result.iat).toBe(0);
    });

    it('should throw EXPIRED for expired tokens', async () => {
      (jose.jwtVerify as jest.Mock).mockRejectedValueOnce(new jose.errors.JWTExpired('expired', {} as any));
      await expect(verifier.verify('expired-token')).rejects.toMatchObject({ code: 'EXPIRED' });
    });

    it('should throw INVALID_SIGNATURE for bad signatures', async () => {
      (jose.jwtVerify as jest.Mock).mockRejectedValueOnce(new jose.errors.JWSSignatureVerificationFailed('bad sig'));
      await expect(verifier.verify('bad-sig-token')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    });

    it('should throw INVALID_CLAIMS for claim validation failures', async () => {
      (jose.jwtVerify as jest.Mock).mockRejectedValueOnce(new jose.errors.JWTClaimValidationFailed('bad claims', {} as any));
      await expect(verifier.verify('bad-claims-token')).rejects.toMatchObject({ code: 'INVALID_CLAIMS' });
    });

    it('should re-throw TokenVerificationError as-is', async () => {
      (jose.jwtVerify as jest.Mock).mockRejectedValueOnce(new TokenVerificationError('custom', 'NETWORK_ERROR'));
      await expect(verifier.verify('token')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    });

    it('should wrap unknown errors as INVALID_CLAIMS', async () => {
      (jose.jwtVerify as jest.Mock).mockRejectedValueOnce(new Error('unknown'));
      await expect(verifier.verify('token')).rejects.toMatchObject({ code: 'INVALID_CLAIMS' });
    });

    it('should wrap non-Error throws as INVALID_CLAIMS', async () => {
      (jose.jwtVerify as jest.Mock).mockRejectedValueOnce('string error');
      await expect(verifier.verify('token')).rejects.toMatchObject({ code: 'INVALID_CLAIMS' });
    });
  });

  describe('JWKS caching', () => {
    it('should cache JWKS and reuse on second call', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: { sub: 'u', exp: 1, iat: 1 },
      });

      await verifier.verify('token1');
      await verifier.verify('token2');
      expect(jose.createRemoteJWKSet).toHaveBeenCalledTimes(1);
    });

    it('should refresh JWKS after invalidateCache', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: { sub: 'u', exp: 1, iat: 1 },
      });

      await verifier.verify('token1');
      verifier.invalidateCache();
      await verifier.verify('token2');
      expect(jose.createRemoteJWKSet).toHaveBeenCalledTimes(2);
    });
  });

  describe('getIssuer / getAudience', () => {
    it('should return correct issuer URL', () => {
      expect(verifier.getIssuer()).toBe('https://test.auth0.com/');
    });

    it('should return correct audience', () => {
      expect(verifier.getAudience()).toBe('https://api.test.com');
    });
  });
});

describe('TokenVerificationError', () => {
  it('should have correct name and code', () => {
    const err = new TokenVerificationError('msg', 'EXPIRED');
    expect(err.name).toBe('TokenVerificationError');
    expect(err.code).toBe('EXPIRED');
    expect(err.message).toBe('msg');
    expect(err instanceof Error).toBe(true);
  });
});

describe('createAuth0VerifierFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return null when AUTH0_DOMAIN is missing', () => {
    delete process.env.AUTH0_DOMAIN;
    process.env.AUTH0_AUDIENCE = 'aud';
    expect(createAuth0VerifierFromEnv()).toBeNull();
  });

  it('should return null when AUTH0_AUDIENCE is missing', () => {
    process.env.AUTH0_DOMAIN = 'domain';
    delete process.env.AUTH0_AUDIENCE;
    expect(createAuth0VerifierFromEnv()).toBeNull();
  });

  it('should return null when both are missing', () => {
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_AUDIENCE;
    expect(createAuth0VerifierFromEnv()).toBeNull();
  });

  it('should return Auth0Verifier when both env vars are set', () => {
    process.env.AUTH0_DOMAIN = 'test.auth0.com';
    process.env.AUTH0_AUDIENCE = 'https://api.test.com';
    const result = createAuth0VerifierFromEnv();
    expect(result).toBeInstanceOf(Auth0Verifier);
    expect(result!.getIssuer()).toBe('https://test.auth0.com/');
  });
});
