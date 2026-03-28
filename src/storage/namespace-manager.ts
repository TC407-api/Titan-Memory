/**
 * Namespace Manager - Multi-Agent Memory Isolation
 * Titan Memory v2.2 Phase 3
 *
 * Provides three isolation levels:
 * - private: only the writing agent can read
 * - project: all agents in the same project can read
 * - global: all agents can read (default, backward compatible)
 */

/** Valid namespace levels for memory isolation */
export type MemoryNamespace = 'private' | 'project' | 'global';

const VALID_NAMESPACES: Set<string> = new Set(['private', 'project', 'global']);

/**
 * Manages namespace tagging and filter generation for multi-agent isolation.
 */
export class NamespaceManager {
  /**
   * Tag memory metadata with agent and namespace information.
   * Preserves all existing metadata fields.
   */
  tagMemory(
    metadata: Record<string, unknown>,
    agentId?: string,
    namespace?: MemoryNamespace,
    projectId?: string,
  ): Record<string, unknown> {
    const validNs = namespace && VALID_NAMESPACES.has(namespace)
      ? namespace
      : 'global';

    const tagged: Record<string, unknown> = { ...metadata };
    tagged.namespace = validNs;

    if (agentId) {
      tagged.agentId = agentId;
    }

    if (projectId && validNs === 'project') {
      tagged.projectId = projectId;
    }

    return tagged;
  }

  /**
   * Build a Zilliz-compatible filter expression for namespace isolation.
   *
   * - private + agentId: only that agent's private memories
   * - project + projectId: all memories in the project namespace for that project
   * - global (default): everything EXCEPT other agents' private memories
   * - global + agentId: own private + all project + all global (excludes foreign private)
   */
  buildFilter(
    agentId?: string,
    namespace?: string,
    projectId?: string,
  ): string {
    // No namespace or no agentId: legacy/global — no filter
    if (!namespace && !agentId) {
      return '';
    }

    const ns = namespace && VALID_NAMESPACES.has(namespace)
      ? namespace as MemoryNamespace
      : 'global';

    switch (ns) {
      case 'private': {
        if (!agentId) return '';
        // Only this agent's private memories
        return `(namespace == "private" && agentId == "${agentId}")`;
      }

      case 'project': {
        if (!projectId) return '';
        // All memories in the project namespace for this project
        return `(namespace == "project" && projectId == "${projectId}")`;
      }

      case 'global': {
        if (!agentId) return '';
        // See everything EXCEPT other agents' private memories
        // Logic: namespace != "private" OR (namespace == "private" AND agentId == self)
        return `(namespace != "private" || agentId == "${agentId}")`;
      }

      default:
        return '';
    }
  }
}
