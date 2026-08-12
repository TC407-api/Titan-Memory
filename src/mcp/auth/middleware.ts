/**
 * Express Authentication Middleware for MCP HTTP Transport
 * Validates JWT tokens and enforces scope-based authorization
 */

import { Request, Response, NextFunction } from 'express';
import { Auth0Verifier, VerifiedToken, TokenVerificationError } from './auth0-verifier.js';
import { hasRequiredScopes, getRequiredScopes } from './scopes.js';
import { isLocalhost } from '../../utils/auth.js';

/**
 * Auth middleware configuration
 */
export interface AuthMiddlewareConfig {
  /** Auth0 verifier instance */
  verifier: Auth0Verifier;
  /** Allow localhost requests without authentication (dev mode) */
  allowLocalhostBypass?: boolean;
  /** Log authentication events to stderr */
  enableAuditLog?: boolean;
}

/**
 * Extended Express Request with auth info
 */
export interface AuthenticatedRequest extends Request {
  auth?: {
    token?: VerifiedToken;
    bypassed: boolean;
  };
}

/**
 * Authentication result for logging
 */
interface AuthEvent {
  timestamp: string;
  type: 'success' | 'failure' | 'bypass';
  subject?: string;
  scopes?: string[];
  tool?: string;
  error?: string;
  remoteAddress?: string;
}

/**
 * Log authentication event to stderr
 */
function logAuthEvent(event: AuthEvent): void {
  console.error(`[titan-memory:auth] ${JSON.stringify(event)}`);
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Create authentication middleware for Express
 */
export function createAuthMiddleware(config: AuthMiddlewareConfig) {
  const { verifier, allowLocalhostBypass = false, enableAuditLog = true } = config;

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const remoteAddress = req.ip || req.socket.remoteAddress;

    // Check for localhost bypass
    if (allowLocalhostBypass && isLocalhost(remoteAddress)) {
      if (enableAuditLog) {
        logAuthEvent({
          timestamp: new Date().toISOString(),
          type: 'bypass',
          remoteAddress,
        });
      }
      req.auth = { bypassed: true };
      next();
      return;
    }

    // Extract Bearer token
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      if (enableAuditLog) {
        logAuthEvent({
          timestamp: new Date().toISOString(),
          type: 'failure',
          error: 'Missing or invalid Authorization header',
          remoteAddress,
        });
      }
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header. Expected: Bearer <token>',
      });
      return;
    }

    // Verify token
    try {
      const verifiedToken = await verifier.verify(token);

      if (enableAuditLog) {
        logAuthEvent({
          timestamp: new Date().toISOString(),
          type: 'success',
          subject: verifiedToken.sub,
          scopes: verifiedToken.scopes,
          remoteAddress,
        });
      }

      req.auth = { token: verifiedToken, bypassed: false };
      next();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof TokenVerificationError ? error.code : 'UNKNOWN';

      if (enableAuditLog) {
        logAuthEvent({
          timestamp: new Date().toISOString(),
          type: 'failure',
          error: `${errorCode}: ${errorMessage}`,
          remoteAddress,
        });
      }

      // Map error codes to HTTP status codes
      const statusCode = errorCode === 'EXPIRED' ? 401 : 401;

      res.status(statusCode).json({
        error: 'Unauthorized',
        code: errorCode,
        message: errorMessage,
      });
    }
  };
}

/**
 * Create scope checking middleware for specific tools
 * Use after createAuthMiddleware to enforce tool-level permissions
 */
export function createScopeMiddleware(config: { enableAuditLog?: boolean } = {}) {
  const { enableAuditLog = true } = config;

  return (toolName: string) => {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      // If auth was bypassed (localhost), allow all
      if (req.auth?.bypassed) {
        next();
        return;
      }

      // If no auth info, reject
      if (!req.auth?.token) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
        return;
      }

      const { scopes, sub } = req.auth.token;

      // Check if token has required scopes for this tool
      if (!hasRequiredScopes(toolName, scopes)) {
        const requiredScopes = getRequiredScopes(toolName);

        if (enableAuditLog) {
          logAuthEvent({
            timestamp: new Date().toISOString(),
            type: 'failure',
            subject: sub,
            scopes,
            tool: toolName,
            error: `Missing required scopes: ${requiredScopes.join(', ')}`,
            remoteAddress: req.ip || req.socket.remoteAddress,
          });
        }

        res.status(403).json({
          error: 'Forbidden',
          message: `Insufficient permissions. Required scopes: ${requiredScopes.join(', ')}`,
          requiredScopes,
          providedScopes: scopes,
        });
        return;
      }

      next();
    };
  };
}

/**
 * Check scopes directly without middleware (for use in tool handlers)
 */
export function checkToolAccess(
  auth: AuthenticatedRequest['auth'],
  toolName: string
): { allowed: boolean; error?: string } {
  // Bypassed auth (localhost) - allow all
  if (auth?.bypassed) {
    return { allowed: true };
  }

  // No auth info
  if (!auth?.token) {
    return { allowed: false, error: 'Authentication required' };
  }

  const { scopes } = auth.token;

  if (!hasRequiredScopes(toolName, scopes)) {
    const requiredScopes = getRequiredScopes(toolName);
    return {
      allowed: false,
      error: `Missing required scopes: ${requiredScopes.join(', ')}`,
    };
  }

  return { allowed: true };
}
