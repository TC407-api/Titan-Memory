/**
 * Security Middleware for Titan Memory Dashboard
 * Implements Mozilla Observatory A+ grade security headers
 *
 * Headers:
 * - Content-Security-Policy (CSP): Controls allowed content sources
 * - X-Frame-Options: Prevents clickjacking
 * - X-Content-Type-Options: Prevents MIME sniffing
 * - Referrer-Policy: Controls referrer information
 * - Strict-Transport-Security: Enforces HTTPS (production only)
 * - Permissions-Policy: Controls browser features
 */

import type { IncomingMessage, ServerResponse } from 'http';

export interface SecurityConfig {
  /** Enable HSTS (only enable in production with HTTPS) */
  enableHsts?: boolean;
  /** HSTS max-age in seconds (default: 1 year) */
  hstsMaxAge?: number;
  /** Additional script sources for CSP */
  additionalScriptSources?: string[];
  /** Additional style sources for CSP */
  additionalStyleSources?: string[];
  /** Additional connect sources for CSP (WebSocket, API) */
  additionalConnectSources?: string[];
  /** Report-only mode for CSP (useful for testing) */
  cspReportOnly?: boolean;
}

const DEFAULT_CONFIG: SecurityConfig = {
  enableHsts: false, // Disabled by default for localhost development
  hstsMaxAge: 31536000, // 1 year
  additionalScriptSources: [],
  additionalStyleSources: [],
  additionalConnectSources: [],
  cspReportOnly: false,
};

/**
 * Build Content-Security-Policy header value
 */
function buildCsp(config: SecurityConfig, host: string): string {
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');

  // Base sources — unsafe-inline removed for scripts; CDN scripts load via src
  const scriptSources = [
    "'self'",
    'https://cdn.jsdelivr.net',
    ...(config.additionalScriptSources || []),
  ];

  const styleSources = [
    "'self'",
    // Allow inline styles for dynamic styling
    "'unsafe-inline'",
    ...(config.additionalStyleSources || []),
  ];

  const connectSources = [
    "'self'",
    // WebSocket for real-time updates
    isLocalhost ? 'ws://localhost:*' : 'wss://*',
    isLocalhost ? 'ws://127.0.0.1:*' : '',
    ...(config.additionalConnectSources || []),
  ].filter(Boolean);

  const imgSources = [
    "'self'",
    'data:', // For inline images/icons
    'blob:', // For dynamically generated images
  ];

  const fontSources = [
    "'self'",
    'data:', // For inline fonts
  ];

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSources.join(' ')}`,
    `style-src ${styleSources.join(' ')}`,
    `connect-src ${connectSources.join(' ')}`,
    `img-src ${imgSources.join(' ')}`,
    `font-src ${fontSources.join(' ')}`,
    `object-src 'none'`, // Disable plugins
    `frame-ancestors 'none'`, // Prevent framing
    `base-uri 'self'`, // Restrict base tag
    `form-action 'self'`, // Restrict form submissions
    `upgrade-insecure-requests`, // Upgrade HTTP to HTTPS
  ];

  return directives.join('; ');
}

/**
 * Build Permissions-Policy header value
 */
function buildPermissionsPolicy(): string {
  // Restrict access to sensitive browser features
  const policies = [
    'accelerometer=()',
    'camera=()',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'payment=()',
    'usb=()',
  ];

  return policies.join(', ');
}

/**
 * Apply security headers to an HTTP response
 */
export function applySecurityHeaders(
  res: ServerResponse,
  config: Partial<SecurityConfig> = {},
  host: string = 'localhost'
): void {
  const mergedConfig: SecurityConfig = { ...DEFAULT_CONFIG, ...config };

  // Content-Security-Policy
  const cspHeaderName = mergedConfig.cspReportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  res.setHeader(cspHeaderName, buildCsp(mergedConfig, host));

  // X-Frame-Options - Prevent clickjacking
  // Note: frame-ancestors in CSP takes precedence, but X-Frame-Options
  // provides backwards compatibility for older browsers
  res.setHeader('X-Frame-Options', 'DENY');

  // X-Content-Type-Options - Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Referrer-Policy - Control referrer information
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // X-XSS-Protection - Legacy XSS protection (deprecated but still useful for older browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // X-DNS-Prefetch-Control - Control DNS prefetching
  res.setHeader('X-DNS-Prefetch-Control', 'off');

  // Permissions-Policy - Control browser features
  res.setHeader('Permissions-Policy', buildPermissionsPolicy());

  // Strict-Transport-Security (HSTS) - Only enable in production
  if (mergedConfig.enableHsts) {
    res.setHeader(
      'Strict-Transport-Security',
      `max-age=${mergedConfig.hstsMaxAge}; includeSubDomains; preload`
    );
  }

  // Cross-Origin headers for additional protection
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

/**
 * Create a security middleware function for use with http.createServer
 */
export function createSecurityMiddleware(config: Partial<SecurityConfig> = {}) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const host = req.headers.host || 'localhost';
    applySecurityHeaders(res, config, host);
  };
}

/**
 * Get security configuration for production
 */
export function getProductionSecurityConfig(): SecurityConfig {
  return {
    enableHsts: true,
    hstsMaxAge: 31536000,
    cspReportOnly: false,
  };
}

/**
 * Get security configuration for development
 */
export function getDevelopmentSecurityConfig(): SecurityConfig {
  return {
    enableHsts: false,
    cspReportOnly: true, // Report-only mode for easier debugging
  };
}
