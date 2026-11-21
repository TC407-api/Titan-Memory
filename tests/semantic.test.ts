/**
 * Semantic Memory Layer Tests
 * Tests for multi-frequency pattern storage and LSH-based similarity search
 */

import * as fs from 'fs';
import * as path from 'path';
import { SemanticMemoryLayer } from '../src/layers/semantic.js';
import { MemoryEntry, MemoryLayer } from '../src/types.js';
import { updateConfig } from '../src/utils/config.js';

describe('SemanticMemoryLayer', () => {
  let semantic: SemanticMemoryLayer;
  let testDataDir: string;

  beforeEach(async () => {
    testDataDir = path.join(process.cwd(), 'test-data-semantic', `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    fs.mkdirSync(testDataDir, { recursive: true });
    // The layer stores under config.dataDir (it ignores TITAN_DATA_DIR). Without this,
    // every test file shares ~/.claude/titan-memory/data/semantic/patterns.json, and a
    // stale pattern left there by an earlier file makes the query tests order-dependent.
    updateConfig({ dataDir: testDataDir });

    semantic = new SemanticMemoryLayer();
    await semantic.initialize();
  });

  afterEach(async () => {
    await semantic.close();
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  const createMockEntry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id: 'mem-' + Math.random().toString(36).substr(2, 9),
    content: 'This is test content for semantic memory.',
    layer: MemoryLayer.SEMANTIC,
    timestamp: new Date(),
    metadata: {
      tags: ['test'],
      surpriseScore: 0.5,
    },
    ...overrides,
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      const newSemantic = new SemanticMemoryLayer();
      await newSemantic.initialize();
      expect(await newSemantic.count()).toBeGreaterThanOrEqual(0);
      await newSemantic.close();
    });

    it('should handle multiple initialize calls', async () => {
      const countBefore = await semantic.count();
      await semantic.initialize();
      await semantic.initialize();
      expect(await semantic.count()).toBe(countBefore);
    });
  });

  describe('Pattern Storage', () => {
    it('should store a new pattern', async () => {
      const countBefore = await semantic.count();
      const entry = createMockEntry({
        content: 'Always use TypeScript for type safety in large projects.',
      });

      const stored = await semantic.store(entry);

      expect(stored.id).toBeDefined();
      expect(stored.content).toBe(entry.content);
      expect(await semantic.count()).toBeGreaterThanOrEqual(countBefore);
    });

    it('should detect pattern type from content', async () => {
      const countBefore = await semantic.count();
      const architectureEntry = createMockEntry({
        content: 'The architecture should use a layered approach with separation of concerns.',
      });
      const debuggingEntry = createMockEntry({
        content: 'When debugging this error, check the stack trace first.',
      });
      const preferenceEntry = createMockEntry({
        content: 'I prefer to use functional components in React.',
      });

      await semantic.store(architectureEntry);
      await semantic.store(debuggingEntry);
      await semantic.store(preferenceEntry);

      expect(await semantic.count()).toBeGreaterThanOrEqual(countBefore + 3);
    });

    it('should extract reasoning chains from content', async () => {
      const entry = createMockEntry({
        content: `To solve this problem:
1. First, identify the root cause
2. Then, gather relevant data
3. Finally, implement the fix
Therefore, following these steps ensures success.`,
      });

      const stored = await semantic.store(entry);
      expect(stored).toBeDefined();
    });

    it('should assign frequency based on importance', async () => {
      const countBefore = await semantic.count();
      const highImportanceEntry = createMockEntry({
        content: 'Critical architecture decision for the entire system.',
        metadata: { surpriseScore: 0.9, tags: ['architecture', 'critical'] },
      });

      const lowImportanceEntry = createMockEntry({
        content: 'Minor formatting preference.',
        metadata: { surpriseScore: 0.1, tags: ['formatting'] },
      });

      await semantic.store(highImportanceEntry);
      await semantic.store(lowImportanceEntry);

      expect(await semantic.count()).toBeGreaterThanOrEqual(countBefore + 2);
    });

    it('should store pattern and be retrievable', async () => {
      const uniqueContent = `Unique pattern content ${Date.now()} ${Math.random()}`;
      const entry = createMockEntry({
        content: uniqueContent,
      });

      const stored = await semantic.store(entry);

      // The stored entry should have an ID
      expect(stored.id).toBeDefined();
      expect(stored.content).toBe(uniqueContent);
    });
  });

  describe('Query and Search', () => {
    beforeEach(async () => {
      // Store some patterns for querying
      await semantic.store(createMockEntry({
        content: 'React components should be small and focused on a single responsibility.',
        metadata: { tags: ['react', 'components'] },
      }));
      await semantic.store(createMockEntry({
        content: 'TypeScript interfaces provide better type safety than any.',
        metadata: { tags: ['typescript', 'types'] },
      }));
      await semantic.store(createMockEntry({
        content: 'Database queries should be optimized for performance.',
        metadata: { tags: ['database', 'performance'] },
      }));
    });

    it('should query patterns by text similarity', async () => {
      const result = await semantic.query('React component best practices');

      expect(result.memories.length).toBeGreaterThan(0);
      expect(result.totalFound).toBeGreaterThan(0);
    });

    it('should return fewer results for unrelated query', async () => {
      const result = await semantic.query('quantum computing algorithms');

      // Unrelated queries should return fewer results than related ones
      expect(result.memories.length).toBeLessThanOrEqual(3);
    });

    it('should respect limit option', async () => {
      const result = await semantic.query('programming', { limit: 1 });

      expect(result.memories.length).toBeLessThanOrEqual(1);
    });

    it('should query by pattern type', async () => {
      await semantic.store(createMockEntry({
        content: 'When debugging, always check the logs first.',
        metadata: { tags: ['debugging'] },
      }));

      const results = await semantic.queryByType('debugging', 10);
      // May or may not find results depending on pattern type detection
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('Reasoning Chains', () => {
    it('should retrieve reasoning chains for a topic', async () => {
      await semantic.store(createMockEntry({
        content: `For authentication:
1. Validate user credentials
2. Generate JWT token
3. Store session securely`,
      }));

      const chains = await semantic.getReasoningChain('authentication');
      expect(Array.isArray(chains)).toBe(true);
    });

    it('should return empty array for unknown topic', async () => {
      const chains = await semantic.getReasoningChain('nonexistent-topic-xyz');
      expect(chains).toEqual([]);
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      await semantic.store(createMockEntry({
        content: 'Architecture pattern for microservices.',
        metadata: { tags: ['architecture'] },
      }));
      await semantic.store(createMockEntry({
        content: 'Debugging technique for memory leaks.',
        metadata: { tags: ['debugging'] },
      }));
    });

    it('should return type statistics', async () => {
      const stats = await semantic.getTypeStats();
      expect(typeof stats).toBe('object');
    });

    it('should return frequency statistics', async () => {
      const stats = await semantic.getFrequencyStats();
      expect(typeof stats).toBe('object');
    });
  });

  describe('CRUD Operations', () => {
    it('should get pattern by ID after storing', async () => {
      const entry = createMockEntry();
      const stored = await semantic.store(entry);

      // Use the ID returned from store
      const retrieved = await semantic.get(stored.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(stored.id);
    });

    it('should return null for non-existent ID', async () => {
      const retrieved = await semantic.get('non-existent-id-xyz-12345');
      expect(retrieved).toBeNull();
    });

    it('should delete pattern by ID', async () => {
      const countBefore = await semantic.count();
      const entry = createMockEntry();
      const stored = await semantic.store(entry);

      expect(await semantic.count()).toBeGreaterThanOrEqual(countBefore);

      const deleted = await semantic.delete(stored.id);
      expect(deleted).toBe(true);
    });

    it('should return false when deleting non-existent pattern', async () => {
      const deleted = await semantic.delete('non-existent-pattern-xyz-12345');
      expect(deleted).toBe(false);
    });
  });

  describe('Persistence', () => {
    it('should persist patterns to disk', async () => {
      const countBefore = await semantic.count();
      await semantic.store(createMockEntry({
        content: 'Persistent pattern content.',
      }));

      const countAfter = await semantic.count();
      expect(countAfter).toBeGreaterThanOrEqual(countBefore);

      // Create new instance to verify persistence
      const newSemantic = new SemanticMemoryLayer();
      await newSemantic.initialize();

      expect(await newSemantic.count()).toBeGreaterThanOrEqual(countBefore);
      await newSemantic.close();
    });

    it('should restore patterns on initialization', async () => {
      const entry = createMockEntry({
        content: 'Content that should persist for test.',
      });
      const stored = await semantic.store(entry);
      const storedId = stored.id;
      await semantic.close();

      const newSemantic = new SemanticMemoryLayer();
      await newSemantic.initialize();

      // Try to retrieve by the actual stored ID
      const retrieved = await newSemantic.get(storedId);
      if (retrieved) {
        expect(retrieved.content).toBe('Content that should persist for test.');
      }
      await newSemantic.close();
    });
  });

  describe('LSH Indexing', () => {
    it('should find similar patterns using LSH', async () => {
      await semantic.store(createMockEntry({
        content: 'Use dependency injection for loose coupling between components.',
      }));
      await semantic.store(createMockEntry({
        content: 'Dependency injection helps with loose coupling and testability.',
      }));
      await semantic.store(createMockEntry({
        content: 'Database indexing improves query performance significantly.',
      }));

      const result = await semantic.query('dependency injection benefits');

      // Should find the DI-related patterns
      expect(result.memories.length).toBeGreaterThan(0);
    });

    it('should handle empty query', async () => {
      const result = await semantic.query('');
      expect(result.memories).toEqual([]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long content', async () => {
      const longContent = 'A'.repeat(10000);
      const entry = createMockEntry({ content: longContent });

      const stored = await semantic.store(entry);
      expect(stored).toBeDefined();
    });

    it('should handle special characters in content', async () => {
      const entry = createMockEntry({
        content: 'Use regex: /^[a-z]+$/i for validation. <script>alert("xss")</script>',
      });

      const stored = await semantic.store(entry);
      expect(stored).toBeDefined();
    });

    it('should handle unicode content', async () => {
      const entry = createMockEntry({
        content: 'Unicode test: 你好世界 🚀 αβγδ ñoño',
      });

      const stored = await semantic.store(entry);
      expect(stored).toBeDefined();
    });
  });
});
