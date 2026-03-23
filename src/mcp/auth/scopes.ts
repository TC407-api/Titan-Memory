/**
 * Tool-to-Scope Mapping for OAuth 2.1 Authorization
 * Defines required scopes for each titan-memory MCP tool
 */

/**
 * OAuth 2.0 scope definitions for titan-memory tools
 */
export const Scopes = {
  READ: 'memory:read',
  WRITE: 'memory:write',
  DELETE: 'memory:delete',
  FEEDBACK: 'memory:feedback',
  ADMIN: 'memory:admin',
  FULL: 'memory:full', // Convenience scope - grants all permissions
} as const;

export type Scope = (typeof Scopes)[keyof typeof Scopes];

/**
 * Mapping of tool names to their required scopes
 */
export const ToolScopes: Record<string, Scope[]> = {
  // Read operations
  titan_recall: [Scopes.READ],
  titan_get: [Scopes.READ],
  titan_stats: [Scopes.READ],
  titan_today: [Scopes.READ],

  // Write operations
  titan_add: [Scopes.WRITE],
  titan_curate: [Scopes.WRITE],

  // Delete operations
  titan_delete: [Scopes.DELETE],

  // Feedback operations
  titan_feedback: [Scopes.FEEDBACK],

  // Read operations (additional)
  titan_category_summary: [Scopes.READ],
  titan_miras_stats: [Scopes.READ],
  titan_noop_stats: [Scopes.READ],
  titan_patterns: [Scopes.READ],
  titan_sufficiency: [Scopes.READ],
  titan_trace: [Scopes.READ],
  titan_why: [Scopes.READ],
  titan_benchmark: [Scopes.READ],
  titan_focus_list: [Scopes.READ],
  titan_scratchpad: [Scopes.READ],

  // Write operations (additional)
  titan_compress: [Scopes.WRITE],
  titan_expand: [Scopes.WRITE],
  titan_link: [Scopes.WRITE],
  titan_classify: [Scopes.WRITE],
  titan_suggest: [Scopes.WRITE],
  titan_focus_add: [Scopes.WRITE],
  titan_focus_remove: [Scopes.WRITE],
  titan_focus_clear: [Scopes.WRITE],
  titan_noop: [Scopes.READ],
  titan_intent: [Scopes.WRITE],

  // Admin operations
  titan_flush: [Scopes.ADMIN],
  titan_prune: [Scopes.ADMIN],
};

/**
 * All available scopes for discovery endpoints
 */
export const AllScopes: Scope[] = [
  Scopes.READ,
  Scopes.WRITE,
  Scopes.DELETE,
  Scopes.FEEDBACK,
  Scopes.ADMIN,
  Scopes.FULL,
];

/**
 * Scope hierarchy - memory:full expands to all scopes
 */
const ScopeExpansions: Record<string, Scope[]> = {
  [Scopes.FULL]: [Scopes.READ, Scopes.WRITE, Scopes.DELETE, Scopes.FEEDBACK, Scopes.ADMIN],
};

/**
 * Expand scopes - resolves convenience scopes like memory:full
 */
export function expandScopes(scopes: string[]): string[] {
  const expanded = new Set<string>();

  for (const scope of scopes) {
    expanded.add(scope);
    const expansion = ScopeExpansions[scope];
    if (expansion) {
      for (const s of expansion) {
        expanded.add(s);
      }
    }
  }

  return Array.from(expanded);
}

/**
 * Check if token scopes satisfy required scopes for a tool
 * @param toolName - The MCP tool being called
 * @param tokenScopes - Scopes from the JWT token
 * @returns true if all required scopes are present
 */
export function hasRequiredScopes(toolName: string, tokenScopes: string[]): boolean {
  const requiredScopes = ToolScopes[toolName];

  // Unknown tool - deny by default
  if (!requiredScopes) {
    return false;
  }

  // Expand any convenience scopes
  const expandedScopes = expandScopes(tokenScopes);

  // Check if all required scopes are present
  return requiredScopes.every(required => expandedScopes.includes(required));
}

/**
 * Get required scopes for a tool
 * @param toolName - The MCP tool name
 * @returns Array of required scopes, or empty array if tool not found
 */
export function getRequiredScopes(toolName: string): Scope[] {
  return ToolScopes[toolName] || [];
}

/**
 * Human-readable scope descriptions for documentation
 */
export const ScopeDescriptions: Record<Scope, string> = {
  [Scopes.READ]: 'Read memories and query the memory system',
  [Scopes.WRITE]: 'Store new memories and curate MEMORY.md',
  [Scopes.DELETE]: 'Delete memories from the system',
  [Scopes.FEEDBACK]: 'Provide utility feedback on memories',
  [Scopes.ADMIN]: 'Administrative operations (flush, prune)',
  [Scopes.FULL]: 'Full access to all memory operations',
};
