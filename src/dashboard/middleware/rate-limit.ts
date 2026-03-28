/**
 * Simple sliding-window rate limiter (no external deps)
 */

import http from 'http';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,    // 1 minute
  maxRequests: 100,     // per IP
};

const requests = new Map<string, number[]>();

// Prune stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - DEFAULT_CONFIG.windowMs;
  for (const [ip, timestamps] of requests) {
    const fresh = timestamps.filter(t => t > cutoff);
    if (fresh.length === 0) requests.delete(ip);
    else requests.set(ip, fresh);
  }
}, 300_000).unref();

function getClientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Returns true if the request should be allowed, false if rate limited.
 * Sets appropriate headers on the response.
 */
export function checkRateLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RateLimitConfig = DEFAULT_CONFIG,
): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const cutoff = now - config.windowMs;

  const timestamps = (requests.get(ip) || []).filter(t => t > cutoff);
  timestamps.push(now);
  requests.set(ip, timestamps);

  const remaining = Math.max(0, config.maxRequests - timestamps.length);
  res.setHeader('X-RateLimit-Limit', config.maxRequests);
  res.setHeader('X-RateLimit-Remaining', remaining);

  if (timestamps.length > config.maxRequests) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return false;
  }

  return true;
}
