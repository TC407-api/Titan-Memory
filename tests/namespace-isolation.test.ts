/**
 * Tests for Multi-Agent Memory Isolation (Phase 3 - v2.2)
 *
 * Verifies:
 * 1. Memory written with agentId stored in metadata
 * 2. Private namespace: only writing agent reads
 * 3. Project namespace: all agents in project read
 * 4. Global namespace: all agents read
 * 5. Cross-namespace query returns zero foreign Private memories
 * 6. Backward compatibility: memories without namespace default to Global
 */

import {
  NamespaceManager,
  MemoryNamespace,
} from '../src/storage/namespace-manager';

describe('NamespaceManager', () => {
  let manager: NamespaceManager;

  beforeEach(() => {
    manager = new NamespaceManager();
  });

  describe('tagMemory', () => {
    it('should add agentId and namespace to metadata', () => {
      const metadata = { tags: ['test'] };
      const result = manager.tagMemory(metadata, 'agent-1', 'private');

      expect(result.agentId).toBe('agent-1');
      expect(result.namespace).toBe('private');
      expect(result.tags).toEqual(['test']);
    });

    it('should default namespace to global when not specified', () => {
      const metadata = {};
      const result = manager.tagMemory(metadata);

      expect(result.namespace).toBe('global');
      expect(result.agentId).toBeUndefined();
    });

    it('should preserve existing metadata fields', () => {
      const metadata = { projectId: 'proj-1', tags: ['important'], source: 'test' };
      const result = manager.tagMemory(metadata, 'agent-2', 'project');

      expect(result.projectId).toBe('proj-1');
      expect(result.tags).toEqual(['important']);
      expect(result.source).toBe('test');
      expect(result.agentId).toBe('agent-2');
      expect(result.namespace).toBe('project');
    });

    it('should add projectId when tagging with project namespace', () => {
      const metadata = {};
      const result = manager.tagMemory(metadata, 'agent-3', 'project', 'my-project');

      expect(result.namespace).toBe('project');
      expect(result.agentId).toBe('agent-3');
      expect(result.projectId).toBe('my-project');
    });
  });

  describe('buildFilter', () => {
    it('should return empty filter for global namespace', () => {
      const filter = manager.buildFilter(undefined, 'global');

      // Global: no namespace filter needed — all memories visible
      expect(filter).toBe('');
    });

    it('should filter by agentId for private namespace', () => {
      const filter = manager.buildFilter('agent-1', 'private');

      expect(filter).toContain('agent-1');
      expect(filter).toContain('private');
    });

    it('should filter by projectId for project namespace', () => {
      const filter = manager.buildFilter('agent-1', 'project', 'proj-1');

      expect(filter).toContain('proj-1');
      expect(filter).toContain('project');
    });

    it('should default to global when no namespace specified', () => {
      const filter = manager.buildFilter();

      expect(filter).toBe('');
    });

    it('should exclude foreign private memories in global queries', () => {
      const filter = manager.buildFilter('agent-1', 'global');

      // When an agent queries globally, it should NOT see other agents' private memories
      // But SHOULD see its own private + all project + all global
      expect(filter).toContain('agent-1');
      // Should exclude foreign private
      expect(filter).toContain('private');
    });
  });

  describe('cross-namespace isolation', () => {
    it('should generate filter that excludes foreign private memories', () => {
      // Agent-1 queries — should not see agent-2's private memories
      const filterAgent1 = manager.buildFilter('agent-1', 'global');
      const filterAgent2 = manager.buildFilter('agent-2', 'global');

      // Filters should be different (agent-specific)
      expect(filterAgent1).not.toBe(filterAgent2);
    });

    it('should allow same-agent to read its own private memories', () => {
      const filter = manager.buildFilter('agent-1', 'private');

      // Should match only agent-1's private memories
      expect(filter).toContain('agent-1');
    });

    it('should allow project-level sharing across agents', () => {
      const filterAgent1 = manager.buildFilter('agent-1', 'project', 'proj-x');
      const filterAgent2 = manager.buildFilter('agent-2', 'project', 'proj-x');

      // Both agents in the same project should see the same project memories
      // The filter should match on projectId, not agentId
      expect(filterAgent1).toContain('proj-x');
      expect(filterAgent2).toContain('proj-x');
    });
  });

  describe('backward compatibility', () => {
    it('should treat memories without namespace as global', () => {
      const metadata = { tags: ['old-memory'] };
      // No agentId, no namespace — backward compat
      const result = manager.tagMemory(metadata);

      expect(result.namespace).toBe('global');
    });

    it('should not break filter when agentId is undefined', () => {
      // Legacy queries without agentId
      const filter = manager.buildFilter(undefined, undefined);

      expect(filter).toBe('');
    });
  });

  describe('namespace validation', () => {
    it('should accept valid namespace values', () => {
      const validNamespaces: MemoryNamespace[] = ['private', 'project', 'global'];

      for (const ns of validNamespaces) {
        const result = manager.tagMemory({}, 'agent-1', ns);
        expect(result.namespace).toBe(ns);
      }
    });

    it('should default invalid namespace to global', () => {
      const result = manager.tagMemory({}, 'agent-1', 'invalid' as MemoryNamespace);

      expect(result.namespace).toBe('global');
    });
  });
});
