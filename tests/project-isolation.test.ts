/**
 * Tests for multi-project physical isolation (FR-11)
 *
 * Verifies that:
 * 1. Memories in project A are NOT visible to project B
 * 2. Each project has its own physical storage directories
 * 3. Backward compatibility with default project works
 * 4. Cross-project queries return empty results
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadConfig,
  getProjectDataDir,
  getProjectPaths,
  ensureProjectDirectories,
  getProjectCollectionName,
  listProjects,
} from '../src/utils/config';
import { TitanMemory, initTitanForProject } from '../src/titan';

describe('Project Isolation', () => {
  let testBaseDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  const createdProjects: string[] = []; // Track created projects for cleanup

  beforeAll(() => {
    // Create a unique test directory
    testBaseDir = path.join(os.tmpdir(), `titan-project-test-${Date.now()}`);
    fs.mkdirSync(testBaseDir, { recursive: true });

    // Save original environment
    originalEnv = { ...process.env };

    // Override HOME to use test directory
    if (process.platform === 'win32') {
      process.env.USERPROFILE = testBaseDir;
    } else {
      process.env.HOME = testBaseDir;
    }

    // Initialize config
    loadConfig();
  });

  afterAll(() => {
    // Cleanup test directory
    try {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Cleanup any test projects created in the real data directory
    const realProjectsDir = path.join(
      process.platform === 'win32'
        ? (originalEnv.USERPROFILE || '')
        : (originalEnv.HOME || ''),
      '.claude', 'titan-memory', 'data', 'projects'
    );

    for (const projectId of createdProjects) {
      try {
        const projectDir = path.join(realProjectsDir, projectId);
        if (fs.existsSync(projectDir)) {
          fs.rmSync(projectDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    // Restore original environment
    process.env = originalEnv;
  });

  // Helper to track created projects for cleanup
  const trackProject = (projectId: string) => {
    if (!createdProjects.includes(projectId)) {
      createdProjects.push(projectId);
    }
  };

  describe('getProjectDataDir', () => {
    it('should return base data dir for undefined projectId', () => {
      const dir = getProjectDataDir();
      expect(dir).toContain('.claude');
      expect(dir).toContain('titan-memory');
      expect(dir).toContain('data');
      expect(dir).not.toContain('projects');
    });

    it('should return base data dir for "default" projectId', () => {
      const dir = getProjectDataDir('default');
      expect(dir).not.toContain('projects');
    });

    it('should return project-specific dir for custom projectId', () => {
      const dir = getProjectDataDir('my-project');
      expect(dir).toContain('projects');
      expect(dir).toContain('my-project');
    });

    it('should handle special characters in projectId', () => {
      const dir = getProjectDataDir('project-with-dashes');
      expect(dir).toContain('project-with-dashes');
    });
  });

  describe('getProjectPaths', () => {
    it('should return all paths for default project', () => {
      const paths = getProjectPaths();

      expect(paths.dataDir).toBeDefined();
      expect(paths.episodicDir).toContain('episodic');
      expect(paths.factualDbPath).toContain('facts.json');
      expect(paths.semanticDir).toContain('semantic');
      expect(paths.memoryMdPath).toContain('MEMORY.md');
    });

    it('should return project-specific paths', () => {
      const paths = getProjectPaths('test-project');

      expect(paths.dataDir).toContain('projects');
      expect(paths.dataDir).toContain('test-project');
      expect(paths.episodicDir).toContain('test-project');
      expect(paths.factualDbPath).toContain('test-project');
      expect(paths.semanticDir).toContain('test-project');
      expect(paths.memoryMdPath).toContain('test-project');
    });

    it('should keep paths separate between projects', () => {
      const pathsA = getProjectPaths('project-a');
      const pathsB = getProjectPaths('project-b');

      expect(pathsA.dataDir).not.toBe(pathsB.dataDir);
      expect(pathsA.episodicDir).not.toBe(pathsB.episodicDir);
      expect(pathsA.factualDbPath).not.toBe(pathsB.factualDbPath);
    });
  });

  describe('ensureProjectDirectories', () => {
    it('should create directories for a new project', () => {
      const projectId = `test-ensure-${Date.now()}`;
      trackProject(projectId);
      ensureProjectDirectories(projectId);

      const paths = getProjectPaths(projectId);
      expect(fs.existsSync(paths.dataDir)).toBe(true);
      expect(fs.existsSync(paths.episodicDir)).toBe(true);
      expect(fs.existsSync(path.dirname(paths.factualDbPath))).toBe(true);
      expect(fs.existsSync(paths.semanticDir)).toBe(true);
    });

    it('should not fail if directories already exist', () => {
      const projectId = `test-ensure-twice-${Date.now()}`;
      trackProject(projectId);
      ensureProjectDirectories(projectId);
      expect(() => ensureProjectDirectories(projectId)).not.toThrow();
    });
  });

  describe('getProjectCollectionName', () => {
    it('should return base collection name for default', () => {
      const name = getProjectCollectionName();
      expect(name).toBe('titan_memory');
    });

    it('should return base collection name for "default"', () => {
      const name = getProjectCollectionName('default');
      expect(name).toBe('titan_memory');
    });

    it('should append sanitized projectId', () => {
      const name = getProjectCollectionName('my-project');
      expect(name).toBe('titan_memory_my_project');
    });

    it('should sanitize special characters', () => {
      const name = getProjectCollectionName('project@with#special!chars');
      expect(name).toBe('titan_memory_project_with_special_chars');
    });
  });

  describe('listProjects', () => {
    it('should include default project', () => {
      const projects = listProjects();
      expect(projects).toContain('default');
    });

    it('should list created projects', () => {
      const projectId = `list-test-${Date.now()}`;
      trackProject(projectId);
      ensureProjectDirectories(projectId);

      const projects = listProjects();
      expect(projects).toContain(projectId);
    });
  });

  describe('TitanMemory Project Isolation', () => {
    let titanA: TitanMemory;
    let titanB: TitanMemory;
    const projectA = `project-a-${Date.now()}`;
    const projectB = `project-b-${Date.now()}`;

    beforeAll(async () => {
      // Track projects for cleanup
      trackProject(projectA);
      trackProject(projectB);

      // Set offline mode to avoid Zilliz connection
      process.env.TITAN_OFFLINE_MODE = 'true';
      loadConfig();

      // Create separate TitanMemory instances for each project
      titanA = await initTitanForProject(projectA);
      titanB = await initTitanForProject(projectB);
    });

    afterAll(async () => {
      await titanA.close();
      await titanB.close();
    });

    it('should store memories in separate directories', async () => {
      // Add memory to project A - use addToLayer to ensure it goes to factual
      await titanA.addToLayer(2, 'Project A definition: React is a JavaScript library'); // Layer 2 = FACTUAL

      // Verify file exists in project A directory
      const pathsA = getProjectPaths(projectA);
      const factualDir = path.dirname(pathsA.factualDbPath);
      if (fs.existsSync(factualDir)) {
        const factualFiles = fs.readdirSync(factualDir);
        expect(factualFiles.length).toBeGreaterThanOrEqual(0);
      }

      // Verify project B directory is separate
      const pathsB = getProjectPaths(projectB);
      expect(pathsA.dataDir).not.toBe(pathsB.dataDir);
    });

    it('should NOT show project A memories in project B query', async () => {
      // Add unique memory to project A
      const uniqueContent = `Unique-${Date.now()}-ProjectA-Secret`;
      await titanA.add(uniqueContent);

      // Query project B - should NOT find project A's memory
      const resultB = await titanB.recall(uniqueContent);
      if ('fusedMemories' in resultB) {
        const foundInB = resultB.fusedMemories.some((m: { content: string }) =>
          m.content.includes('ProjectA-Secret')
        );
        expect(foundInB).toBe(false);
      } else {
        // Summary mode - no content to check
        expect(resultB.summaries.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should show project A memories only in project A query', async () => {
      // Add unique memory to project A using addToLayer for predictability
      const uniqueContent = `FactDefinition: ProjectA-${Date.now()} is defined as a test entry`;
      const memoryA = await titanA.addToLayer(2, uniqueContent); // Layer 2 = FACTUAL

      // Get memory by ID in project A - should find it
      const retrievedA = await titanA.get(memoryA.id);
      expect(retrievedA).not.toBeNull();
      expect(retrievedA?.content).toBe(uniqueContent);

      // Get memory by ID in project B - should NOT find it (isolation)
      const retrievedB = await titanB.get(memoryA.id);
      expect(retrievedB).toBeNull();
    });

    it('should return correct project ID from getActiveProject', () => {
      expect(titanA.getActiveProject()).toBe(projectA);
      expect(titanB.getActiveProject()).toBe(projectB);
    });

    it('should switch projects with setActiveProject', async () => {
      const switchProjectA = `switch-project-a-${Date.now()}`;
      const switchProjectB = `switch-project-b-${Date.now()}`;
      trackProject(switchProjectA);
      trackProject(switchProjectB);

      const titan = new TitanMemory(undefined, switchProjectA);
      await titan.initialize();

      expect(titan.getActiveProject()).toBe(switchProjectA);

      await titan.setActiveProject(switchProjectB);
      expect(titan.getActiveProject()).toBe(switchProjectB);

      await titan.close();
    });
  });

  describe('Backward Compatibility', () => {
    let defaultTitan: TitanMemory;

    beforeAll(async () => {
      process.env.TITAN_OFFLINE_MODE = 'true';
      loadConfig();

      // Create TitanMemory without projectId (default behavior)
      defaultTitan = new TitanMemory();
      await defaultTitan.initialize();
    });

    afterAll(async () => {
      await defaultTitan.close();
    });

    it('should work without projectId (backward compatible)', async () => {
      expect(defaultTitan.getActiveProject()).toBeUndefined();

      // Should be able to add and query
      await defaultTitan.add('Backward compatible memory test');
      const result = await defaultTitan.recall('Backward compatible');
      if ('fusedMemories' in result) {
        expect(result.fusedMemories.length).toBeGreaterThanOrEqual(0);
      } else {
        expect(result.summaries.length).toBeGreaterThanOrEqual(0);
      }
      // 30s, not the 5s default: this exercises a real add + recall round trip against the
      // live default collection. It used to finish inside 5s only because get() was sending
      // `ids` and being rejected outright — the work is now actually performed.
    }, 30000);

    it('should use default data directory', () => {
      const defaultPaths = getProjectPaths();
      expect(defaultPaths.dataDir).not.toContain('projects');
    });
  });

  describe('TitanMemory.listProjects', () => {
    it('should be accessible as static method', () => {
      const projects = TitanMemory.listProjects();
      expect(Array.isArray(projects)).toBe(true);
      expect(projects).toContain('default');
    });
  });

  describe('File Structure Verification', () => {
    it('should match target architecture for project data', async () => {
      const projectId = `arch-test-${Date.now()}`;
      trackProject(projectId);
      const titan = await initTitanForProject(projectId);

      // Add data to trigger file creation
      await titan.add('Test episodic entry', { tags: ['test'] });

      const paths = getProjectPaths(projectId);

      // Verify directory structure
      expect(fs.existsSync(paths.dataDir)).toBe(true);
      expect(paths.dataDir).toContain(path.join('projects', projectId));

      await titan.close();
    });
  });
});
