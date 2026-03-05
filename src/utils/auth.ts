/**
 * Authentication utilities for Titan Memory
 * Provides token-based authentication for Dashboard API and A2A WebSocket
 */

import crypto from 'crypto';

export interface AuthConfig {
  /** Enable authentication (default: true in production, false in development) */
  enabled: boolean;
  /** API tokens allowed to access the dashboard */
  dashboardTokens: string[];
  /** Tokens allowed for A2A agent connections */
  a2aTokens: string[];
  /** Token header name (default: 'X-Titan-Token') */
  tokenHeader: string;
  /** Allow localhost without auth (default: true) */
  allowLocalhostWithoutAuth: boolean;
}

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  enabled: process.env.NODE_ENV === 'production',
  dashboardTokens: process.env.TITAN_DASHBOARD_TOKENS?.split(',').filter(Boolean) || [],
  a2aTokens: process.env.TITAN_A2A_TOKENS?.split(',').filter(Boolean) || [],
  tokenHeader: 'X-Titan-Token',
  allowLocalhostWithoutAuth: true,
};

let authConfig: AuthConfig = { ...DEFAULT_AUTH_CONFIG };

/**
 * Initialize auth configuration
 */
export function initAuth(config?: Partial<AuthConfig>): AuthConfig {
  authConfig = { ...DEFAULT_AUTH_CONFIG, ...config };
  return authConfig;
}

/**
 * Get current auth configuration
 */
export function getAuthConfig(): AuthConfig {
  return authConfig;
}

/**
 * Generate a secure random token
 */
export function generateToken(): string {
  return `titan_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Constant-time token comparison to prevent timing side-channel attacks
 */
function timingSafeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Validate a dashboard token (timing-safe)
 */
export function validateDashboardToken(token: string | undefined): boolean {
  if (!authConfig.enabled) return true;
  if (!token) return false;
  return authConfig.dashboardTokens.some(t => timingSafeTokenCompare(t, token));
}

/**
 * Validate an A2A token (timing-safe)
 */
export function validateA2AToken(token: string | undefined): boolean {
  if (!authConfig.enabled) return true;
  if (!token) return false;
  return authConfig.a2aTokens.some(t => timingSafeTokenCompare(t, token));
}

/**
 * Check if request is from localhost
 */
export function isLocalhost(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === 'localhost' ||
    remoteAddress.startsWith('::ffff:127.')
  );
}

/**
 * Check if request should bypass auth (localhost exemption)
 */
export function shouldBypassAuth(remoteAddress: string | undefined): boolean {
  if (!authConfig.enabled) return true;
  if (authConfig.allowLocalhostWithoutAuth && isLocalhost(remoteAddress)) {
    return true;
  }
  return false;
}

/**
 * Sanitize user input to prevent injection attacks
 * Escapes special characters that could be used in filter expressions
 */
export function sanitizeFilterValue(value: string): string {
  // Escape characters that could be used for injection
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

/**
 * Validate that a value is a valid UUID (for memory IDs)
 */
export function isValidUUID(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Validate CORS origin against whitelist
 */
export function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.some(allowed => {
    if (allowed === origin) return true;
    // Support wildcard subdomains like *.example.com
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      return origin.endsWith(domain) || origin === `https://${domain}` || origin === `http://${domain}`;
    }
    return false;
  });
}
