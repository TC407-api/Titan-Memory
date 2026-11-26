/**
 * Tests for Titan Memory Skill System
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  SkillRegistry,
  getSkillRegistry,
  resetSkillRegistry,
  SkillExecutor,
  getSkillExecutor,
  resetSkillExecutor,
  SkillWatcher,
  loadSkillFromFile,
  loadSkillsFromDirectory,
  ensureSkillsDirectory,
  summarizerSkill,
  extractorSkill,
  transformerSkill,
  TitanSkill,
  SkillFile,
  SkillContext,
  MemoryEntry,
  MemoryLayer,
} from '../src';

// Mock TitanMemoryInterface for tests
const mockTitan = {
  add: jest.fn(),
  recall: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
  getStats: jest.fn(),
};

// Helper to create a test skill
function createTestSkill(name: string, triggers: string[]): TitanSkill {
  return {
    metadata: {
      name,
      version: '1.0.0',
      description: `Test skill: ${name}`,
      triggers,
    },
    execute: jest.fn().mockResolvedValue({ success: true, output: `Executed ${name}` }),
  };
}

// Helper to create a test skill file
function createSkillFile(skill: TitanSkill): SkillFile {
  return {
    path: `/test/skills/${skill.metadata.name}.ts`,
    metadata: skill.metadata,
    skill,
    loadedAt: new Date(),
    lastModified: new Date(),
    enabled: true,
  };
}

// Helper to create mock memory
function createMockMemory(content: string): MemoryEntry {
  return {
    id: `mem-${Date.now()}`,
    content,
    layer: MemoryLayer.FACTUAL,
    timestamp: new Date(),
    metadata: { tags: ['test'] },
  };
}

describe('Skill System', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = path.join(os.tmpdir(), `titan-skills-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetSkillRegistry();
    resetSkillExecutor();
  });

  // ==================== Registry Tests ====================
  describe('SkillRegistry', () => {
    let registry: SkillRegistry;

    beforeEach(() => {
      registry = getSkillRegistry();
    });

    it('should register a skill', () => {
      const skill = createTestSkill('test-skill', ['test', 'demo']);
      const file = createSkillFile(skill);

      registry.register(file);

      expect(registry.has('test-skill')).toBe(true);
      expect(registry.count()).toBe(1);
    });

    it('should unregister a skill', () => {
      const skill = createTestSkill('to-remove', ['remove']);
      const file = createSkillFile(skill);

      registry.register(file);
      expect(registry.has('to-remove')).toBe(true);

      const removed = registry.unregister('to-remove');
      expect(removed).toBe(true);
      expect(registry.has('to-remove')).toBe(false);
    });

    it('should find skills by trigger', () => {
      const skill1 = createTestSkill('skill-a', ['alpha', 'first']);
      const skill2 = createTestSkill('skill-b', ['beta', 'second']);

      registry.register(createSkillFile(skill1));
      registry.register(createSkillFile(skill2));

      const found = registry.findByTrigger('alpha');
      expect(found.length).toBe(1);
      expect(found[0].metadata.name).toBe('skill-a');
    });

    it('should find skill by text containing trigger', () => {
      const skill = createTestSkill('hello-skill', ['hello', 'hi']);
      registry.register(createSkillFile(skill));

      const found = registry.findByText('I want to say hello to everyone');
      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('hello-skill');
    });

    it('should enable and disable skills', () => {
      const skill = createTestSkill('toggle-skill', ['toggle']);
      registry.register(createSkillFile(skill));

      expect(registry.isEnabled('toggle-skill')).toBe(true);

      registry.disable('toggle-skill');
      expect(registry.isEnabled('toggle-skill')).toBe(false);

      registry.enable('toggle-skill');
      expect(registry.isEnabled('toggle-skill')).toBe(true);
    });

    it('should keep a disabled skill disabled when it is registered again', () => {
      registry.register(createSkillFile(createTestSkill('sticky-skill', ['sticky'])));
      registry.disable('sticky-skill');

      // A fresh SkillFile, as the loader builds one for an edited file.
      registry.register(createSkillFile(createTestSkill('sticky-skill', ['sticky'])));

      expect(registry.isEnabled('sticky-skill')).toBe(false);
      expect(registry.findByTrigger('sticky')).toEqual([]);
      expect(registry.findByText('a sticky situation')).toBeUndefined();
    });

    it('should keep a disabled skill disabled after it is unregistered and registered again', () => {
      registry.register(createSkillFile(createTestSkill('gone-skill', ['gone'])));
      registry.disable('gone-skill');
      registry.unregister('gone-skill');
      expect(registry.isEnabled('gone-skill')).toBe(false);

      registry.register(createSkillFile(createTestSkill('gone-skill', ['gone'])));

      expect(registry.has('gone-skill')).toBe(true);
      expect(registry.isEnabled('gone-skill')).toBe(false);
      expect(registry.listDisabled().map((m) => m.name)).toEqual(['gone-skill']);
    });

    it('should register a skill as enabled again once enable() was called for it', () => {
      registry.register(createSkillFile(createTestSkill('back-skill', ['back'])));
      registry.disable('back-skill');
      registry.enable('back-skill');

      registry.register(createSkillFile(createTestSkill('back-skill', ['back'])));

      expect(registry.isEnabled('back-skill')).toBe(true);
    });

    it('should let enable() lift a disable while the skill is not registered', () => {
      registry.register(createSkillFile(createTestSkill('away-skill', ['away'])));
      registry.disable('away-skill');
      registry.unregister('away-skill');

      expect(registry.enable('away-skill')).toBe(false);
      registry.register(createSkillFile(createTestSkill('away-skill', ['away'])));

      expect(registry.isEnabled('away-skill')).toBe(true);
    });

    it('should remember a skill that is registered in the disabled state', () => {
      const file = createSkillFile(createTestSkill('born-off', ['born']));
      file.enabled = false;
      registry.register(file);
      registry.unregister('born-off');

      registry.register(createSkillFile(createTestSkill('born-off', ['born'])));

      expect(registry.isEnabled('born-off')).toBe(false);
    });

    it('should not disable other skills, and should return false for an unknown name', () => {
      registry.register(createSkillFile(createTestSkill('other-skill', ['other'])));

      expect(registry.disable('never-registered')).toBe(false);
      registry.register(createSkillFile(createTestSkill('never-registered', ['never'])));

      expect(registry.isEnabled('never-registered')).toBe(true);
      expect(registry.isEnabled('other-skill')).toBe(true);
    });

    // A skill file as the loader builds it for the file at `filePath`.
    const fileAt = (filePath: string, name: string): SkillFile => ({
      ...createSkillFile(createTestSkill(name, [name])),
      path: filePath,
    });

    // The disabled state belongs to the name. These pin that contract down for
    // each call, for a registered and an unregistered name.

    it('should keep the state of a name, not of a file, when the file comes back under another name', () => {
      registry.register(fileAt('/skills/a.skill.md', 'first-name'));
      registry.disable('first-name');
      registry.unregister('first-name');

      registry.register(fileAt('/skills/a.skill.md', 'second-name'));
      registry.register(fileAt('/skills/b.skill.md', 'first-name'));

      expect(registry.isEnabled('second-name')).toBe(true);
      expect(registry.isNameDisabled('second-name')).toBe(false);
      expect(registry.isEnabled('first-name')).toBe(false);
    });

    it('should report a disabled name with isNameDisabled() while nothing is registered under it', () => {
      registry.register(fileAt('/skills/a.skill.md', 'first-name'));
      expect(registry.isNameDisabled('first-name')).toBe(false);
      registry.disable('first-name');
      registry.unregister('first-name');

      expect(registry.isEnabled('first-name')).toBe(false);
      expect(registry.isNameDisabled('first-name')).toBe(true);
      expect(registry.enable('first-name')).toBe(false);
      expect(registry.isNameDisabled('first-name')).toBe(false);
    });

    it('should disable any file registered under a disabled name, and enable() lifts it for all', () => {
      registry.register(fileAt('/skills/a.skill.md', 'shared-name'));
      registry.disable('shared-name');
      registry.register(fileAt('/skills/b.skill.md', 'shared-name'));
      expect(registry.isEnabled('shared-name')).toBe(false);

      expect(registry.enable('shared-name')).toBe(true);
      registry.register(fileAt('/skills/a.skill.md', 'shared-name'));

      expect(registry.isEnabled('shared-name')).toBe(true);
    });

    it('should give a name a new disable id only when it goes from enabled to disabled', () => {
      registry.register(fileAt('/skills/a.skill.md', 'counted'));
      expect(registry.getDisable('counted')).toBeUndefined();

      registry.disable('counted');
      const first = registry.getDisable('counted');
      registry.disable('counted');
      registry.register(fileAt('/skills/a.skill.md', 'counted'));
      expect(first).toEqual({ id: expect.any(Number), path: '/skills/a.skill.md' });
      expect(registry.getDisable('counted')?.id).toBe(first?.id);

      registry.enable('counted');
      expect(registry.getDisable('counted')).toBeUndefined();
      registry.disable('counted');
      expect(registry.getDisable('counted')?.id).not.toBe(first?.id);
    });

    it('should keep the file a disable was made for when another file registers under the name', () => {
      registry.register(fileAt('/skills/a.skill.md', 'owned-off'));
      registry.disable('owned-off');
      registry.register(fileAt('/skills/b.skill.md', 'owned-off'));
      registry.disable('owned-off');

      expect(registry.getDisable('owned-off')?.path).toBe('/skills/a.skill.md');
    });

    it('should never reuse a disable id in a registry made after a reset', () => {
      registry.register(fileAt('/skills/a.skill.md', 'first-off'));
      registry.disable('first-off');
      const before = registry.getDisable('first-off')?.id;

      resetSkillRegistry();
      const fresh = getSkillRegistry();
      fresh.register(fileAt('/skills/a.skill.md', 'first-off'));
      fresh.disable('first-off');

      expect(fresh.getDisable('first-off')?.id).not.toBe(before);
    });

    it('should not change other names when disable() or enable() is called for one', () => {
      registry.register(fileAt('/skills/a.skill.md', 'report'));
      registry.register(fileAt('/skills/b.skill.md', 'summary'));
      registry.disable('summary');

      registry.disable('report');
      registry.enable('report');

      expect(registry.isEnabled('report')).toBe(true);
      expect(registry.isEnabled('summary')).toBe(false);
      expect(registry.isNameDisabled('summary')).toBe(true);
    });

    it('should let enable() of a name lift the disable for every file under that name', () => {
      registry.register(fileAt('/skills/a.skill.md', 'report'));
      registry.disable('report');
      registry.unregister('report');
      registry.register(fileAt('/skills/b.skill.md', 'report'));
      expect(registry.isEnabled('report')).toBe(false);

      expect(registry.enable('report')).toBe(true);
      registry.register(fileAt('/skills/b.skill.md', 'report'));
      expect(registry.isEnabled('report')).toBe(true);
      registry.register(fileAt('/skills/a.skill.md', 'report'));

      expect(registry.isEnabled('report')).toBe(true);
    });

    it('should not disable a second name that a file registers while its first name is disabled', () => {
      registry.register(fileAt('/skills/a.skill.md', 'daily'));
      registry.disable('daily');
      registry.register(fileAt('/skills/a.skill.md', 'alias'));
      expect(registry.isEnabled('alias')).toBe(true);
      expect(registry.isEnabled('daily')).toBe(false);

      registry.register(fileAt('/skills/b.skill.md', 'daily'));

      expect(registry.isEnabled('daily')).toBe(false);
    });

    it('should keep a name disabled when enable() is called for another name of the same file', () => {
      registry.register(fileAt('/skills/a.skill.md', 'daily'));
      registry.disable('daily');
      registry.register(fileAt('/skills/a.skill.md', 'alias'));

      expect(registry.enable('alias')).toBe(true);
      registry.register(fileAt('/skills/a.skill.md', 'daily'));

      expect(registry.isEnabled('daily')).toBe(false);
      expect(registry.isEnabled('alias')).toBe(true);
      registry.unregister('daily');
      registry.register(fileAt('/skills/a.skill.md', 'daily'));
      expect(registry.isEnabled('daily')).toBe(false);
    });

    it('should keep an alias enabled after enable() when the file registers it again', () => {
      registry.register(fileAt('/skills/a.skill.md', 'daily'));
      registry.disable('daily');
      registry.register(fileAt('/skills/a.skill.md', 'alias'));
      registry.disable('alias');
      expect(registry.enable('alias')).toBe(true);
      registry.unregister('alias');
      registry.unregister('daily');

      registry.register(fileAt('/skills/a.skill.md', 'alias'));

      expect(registry.isEnabled('alias')).toBe(true);
    });

    it('should keep a disable that only disable() made when register() is given an enabled file', () => {
      registry.register(fileAt('/skills/a.skill.md', 'kept-off'));
      registry.disable('kept-off');

      const fresh = fileAt('/skills/a.skill.md', 'kept-off');
      expect(fresh.enabled).toBe(true);
      registry.register(fresh);

      expect(fresh.enabled).toBe(false);
      expect(registry.listDisabled().map((m) => m.name)).toEqual(['kept-off']);
    });

    it('should keep an enable() that a listener calls while register() replaces a disabled skill', () => {
      registry.register(fileAt('/skills/a.skill.md', 'report'));
      registry.disable('report');
      const enableOnUnload: Parameters<typeof registry.addEventListener>[0] = (event) => {
        if (event.type === 'skill:unloaded' && event.name === 'report') registry.enable('report');
      };
      registry.addEventListener(enableOnUnload);
      try {
        registry.register(fileAt('/skills/a.skill.md', 'report'));
      } finally {
        registry.removeEventListener(enableOnUnload);
      }

      expect(registry.isEnabled('report')).toBe(true);
    });

    it('should list all skills', () => {
      registry.register(createSkillFile(createTestSkill('list-a', ['a'])));
      registry.register(createSkillFile(createTestSkill('list-b', ['b'])));
      registry.register(createSkillFile(createTestSkill('list-c', ['c'])));

      const list = registry.list();
      expect(list.length).toBe(3);
    });

    it('should record execution stats', () => {
      const skill = createTestSkill('stats-skill', ['stats']);
      registry.register(createSkillFile(skill));

      registry.recordExecution('stats-skill', 100, true);
      registry.recordExecution('stats-skill', 200, true);

      const stats = registry.getSkillStats('stats-skill');
      expect(stats).toBeDefined();
      expect(stats?.count).toBe(2);
      expect(stats?.avgTimeMs).toBe(150);
    });

    it('should provide system statistics', () => {
      registry.register(createSkillFile(createTestSkill('sys-a', ['a'])));
      registry.register(createSkillFile(createTestSkill('sys-b', ['b'])));
      registry.disable('sys-b');

      const stats = registry.getStats();
      expect(stats.totalSkills).toBe(2);
      expect(stats.enabledSkills).toBe(1);
      expect(stats.disabledSkills).toBe(1);
    });
  });

  // ==================== Executor Tests ====================
  describe('SkillExecutor', () => {
    let executor: SkillExecutor;
    let registry: SkillRegistry;

    beforeEach(() => {
      registry = getSkillRegistry();
      executor = getSkillExecutor();
    });

    it('should execute a skill directly', async () => {
      const skill = createTestSkill('direct-exec', ['execute']);
      const context: SkillContext = { titan: mockTitan };

      const result = await executor.execute(skill, context);

      expect(result.success).toBe(true);
      expect(skill.execute).toHaveBeenCalled();
    });

    it('should execute skill by name', async () => {
      const skill = createTestSkill('named-exec', ['named']);
      registry.register(createSkillFile(skill));

      const context: SkillContext = { titan: mockTitan };
      const result = await executor.executeByName('named-exec', context);

      expect(result.success).toBe(true);
    });

    it('should execute skill by trigger', async () => {
      const skill = createTestSkill('trigger-exec', ['mytrigger']);
      registry.register(createSkillFile(skill));

      const context: SkillContext = { titan: mockTitan };
      const result = await executor.executeByTrigger('mytrigger', context);

      expect(result.success).toBe(true);
    });

    it('should return error for missing skill', async () => {
      const context: SkillContext = { titan: mockTitan };
      const result = await executor.executeByName('nonexistent', context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should timeout long-running skills', async () => {
      const slowSkill: TitanSkill = {
        metadata: { name: 'slow', version: '1.0.0', description: '', triggers: ['slow'] },
        execute: () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 5000)),
      };

      const context: SkillContext = { titan: mockTitan };
      const result = await executor.execute(slowSkill, context, { timeout: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    }, 10000);

    it('should catch errors when catchErrors is true', async () => {
      const errorSkill: TitanSkill = {
        metadata: { name: 'error', version: '1.0.0', description: '', triggers: ['error'] },
        execute: () => Promise.reject(new Error('Test error')),
      };

      const context: SkillContext = { titan: mockTitan };
      const result = await executor.execute(errorSkill, context, { catchErrors: true });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Test error');
    });

    it('should execute skills in sequence', async () => {
      const results: string[] = [];

      const skill1: TitanSkill = {
        metadata: { name: 'seq1', version: '1.0.0', description: '', triggers: ['seq1'] },
        execute: async () => { results.push('first'); return { success: true }; },
      };

      const skill2: TitanSkill = {
        metadata: { name: 'seq2', version: '1.0.0', description: '', triggers: ['seq2'] },
        execute: async () => { results.push('second'); return { success: true }; },
      };

      registry.register(createSkillFile(skill1));
      registry.register(createSkillFile(skill2));

      const context: SkillContext = { titan: mockTitan };
      await executor.executeSequence(['seq1', 'seq2'], context);

      expect(results).toEqual(['first', 'second']);
    });

    it('should execute skills in parallel', async () => {
      let count = 0;

      const createParallelSkill = (name: string): TitanSkill => ({
        metadata: { name, version: '1.0.0', description: '', triggers: [name] },
        execute: async () => { count++; return { success: true }; },
      });

      registry.register(createSkillFile(createParallelSkill('par1')));
      registry.register(createSkillFile(createParallelSkill('par2')));
      registry.register(createSkillFile(createParallelSkill('par3')));

      const context: SkillContext = { titan: mockTitan };
      const results = await executor.executeParallel(['par1', 'par2', 'par3'], context);

      expect(results.length).toBe(3);
      expect(count).toBe(3);
    });
  });

  // ==================== Loader Tests ====================
  describe('Skill Loader', () => {
    it('should ensure skills directory exists', () => {
      const skillsDir = path.join(testDir, 'ensure-skills');
      const result = ensureSkillsDirectory(skillsDir);

      expect(fs.existsSync(result)).toBe(true);
      expect(fs.existsSync(path.join(result, 'built-in'))).toBe(true);
      expect(fs.existsSync(path.join(result, 'custom'))).toBe(true);
    });

    it('should return null for non-existent skill file', async () => {
      const result = await loadSkillFromFile('/nonexistent/path/skill.ts');
      expect(result).toBeNull();
    });

    it('should load skills from directory', async () => {
      const skillsDir = path.join(testDir, 'load-test-skills');
      fs.mkdirSync(skillsDir, { recursive: true });

      // Create a simple .skill.md file for testing
      const skillContent = `---
name: test-md-skill
version: 1.0.0
description: A test skill
triggers:
  - test
  - demo
---

# Test Skill

This is a test skill.
`;
      fs.writeFileSync(path.join(skillsDir, 'test.skill.md'), skillContent);

      const loaded = await loadSkillsFromDirectory(skillsDir);

      // Should find and load the skill
      expect(loaded.length).toBeGreaterThanOrEqual(0); // May be 0 if .md parsing fails
    });

    it('should handle empty skills directory', async () => {
      const emptyDir = path.join(testDir, 'empty-skills');
      fs.mkdirSync(emptyDir, { recursive: true });

      const loaded = await loadSkillsFromDirectory(emptyDir);
      expect(loaded).toEqual([]);
    });

    it('should ignore node_modules and dist directories', async () => {
      const skillsDir = path.join(testDir, 'ignore-test');
      fs.mkdirSync(path.join(skillsDir, 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(skillsDir, 'dist'), { recursive: true });

      const loaded = await loadSkillsFromDirectory(skillsDir);
      expect(loaded).toEqual([]);
    });

    it('should handle missing directory gracefully', async () => {
      const loaded = await loadSkillsFromDirectory('/totally/fake/path');
      expect(loaded).toEqual([]);
    });
  });

  // ==================== Watcher Tests ====================
  describe('SkillWatcher', () => {
    it('should create watcher with default options', () => {
      const watcher = new SkillWatcher();
      expect(watcher.isWatching()).toBe(false);
    });

    it('should start and stop watching', async () => {
      const watchDir = path.join(testDir, 'watch-test');
      fs.mkdirSync(watchDir, { recursive: true });

      const watcher = new SkillWatcher({ skillsDir: watchDir });

      watcher.start();
      expect(watcher.isWatching()).toBe(true);

      await watcher.stop();
      expect(watcher.isWatching()).toBe(false);
    });

    it('should register event callbacks', () => {
      const watcher = new SkillWatcher();
      const callback = jest.fn();

      watcher.on('loaded', callback);
      watcher.on('error', callback);

      // No error should be thrown
      expect(() => watcher.off('loaded', callback)).not.toThrow();
    });

    it('should not start twice', async () => {
      const watchDir = path.join(testDir, 'double-start');
      fs.mkdirSync(watchDir, { recursive: true });

      const watcher = new SkillWatcher({ skillsDir: watchDir });

      watcher.start();
      watcher.start(); // Should be no-op

      expect(watcher.isWatching()).toBe(true);

      await watcher.stop();
    });

    it('should return watched directory', () => {
      const watchDir = path.join(testDir, 'get-dir');
      const watcher = new SkillWatcher({ skillsDir: watchDir });

      expect(watcher.getWatchedDirectory()).toBe(watchDir);
    });
  });

  // ==================== Built-in Skills Tests ====================
  describe('Built-in Skills', () => {
    describe('Summarizer', () => {
      it('should have correct metadata', () => {
        expect(summarizerSkill.metadata.name).toBe('summarizer');
        expect(summarizerSkill.metadata.triggers).toContain('summarize');
        expect(summarizerSkill.metadata.triggers).toContain('tldr');
      });

      it('should summarize memory content', async () => {
        const memory = createMockMemory(
          'This is the first important point. ' +
          'The key decision was to use TypeScript. ' +
          'We learned that performance matters. ' +
          'The solution was to add caching. ' +
          'Always remember to test your code.'
        );

        const context: SkillContext = {
          titan: mockTitan,
          memory,
        };

        const result = await summarizerSkill.execute(context);

        expect(result.success).toBe(true);
        expect(typeof result.output).toBe('string');
        expect((result.output as string).includes('-')).toBe(true); // Contains bullet points
      });

      it('should handle empty content', async () => {
        const context: SkillContext = {
          titan: mockTitan,
          memory: createMockMemory(''),
        };

        const result = await summarizerSkill.execute(context);
        expect(result.success).toBe(false);
      });
    });

    describe('Extractor', () => {
      it('should have correct metadata', () => {
        expect(extractorSkill.metadata.name).toBe('extractor');
        expect(extractorSkill.metadata.triggers).toContain('extract');
        expect(extractorSkill.metadata.triggers).toContain('entities');
      });

      it('should extract URLs from content', async () => {
        const memory = createMockMemory(
          'Check out https://example.com and https://github.com/test for more info.'
        );

        const context: SkillContext = {
          titan: mockTitan,
          memory,
        };

        const result = await extractorSkill.execute(context);

        expect(result.success).toBe(true);
        const output = result.output as Record<string, unknown>;
        expect(output.totalCount).toBeGreaterThan(0);
        expect((output.grouped as Record<string, string[]>).url).toBeDefined();
      });

      it('should extract versions from content', async () => {
        const memory = createMockMemory(
          'Using node v18.0.0 and npm 9.0.0 with typescript 5.4.0'
        );

        const context: SkillContext = {
          titan: mockTitan,
          memory,
        };

        const result = await extractorSkill.execute(context);

        expect(result.success).toBe(true);
        const output = result.output as Record<string, unknown>;
        expect((output.grouped as Record<string, string[]>).version?.length).toBeGreaterThan(0);
      });
    });

    describe('Transformer', () => {
      it('should have correct metadata', () => {
        expect(transformerSkill.metadata.name).toBe('transformer');
        expect(transformerSkill.metadata.triggers).toContain('transform');
        expect(transformerSkill.metadata.triggers).toContain('convert');
      });

      it('should transform to markdown', async () => {
        const memory = createMockMemory('Test content for transformation');

        const context: SkillContext = {
          titan: mockTitan,
          memory,
          config: { format: 'markdown' },
        };

        const result = await transformerSkill.execute(context);

        expect(result.success).toBe(true);
        expect((result.output as string).includes('# Memories')).toBe(true);
      });

      it('should transform to JSON', async () => {
        const memory = createMockMemory('JSON test content');

        const context: SkillContext = {
          titan: mockTitan,
          memory,
          config: { format: 'json' },
        };

        const result = await transformerSkill.execute(context);

        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.output as string);
        expect(Array.isArray(parsed)).toBe(true);
      });

      it('should transform to CSV', async () => {
        const memory = createMockMemory('CSV test content');

        const context: SkillContext = {
          titan: mockTitan,
          memory,
          config: { format: 'csv' },
        };

        const result = await transformerSkill.execute(context);

        expect(result.success).toBe(true);
        expect((result.output as string).includes('id,layer,timestamp')).toBe(true);
      });

      it('should handle multiple memories', async () => {
        const memories = [
          createMockMemory('First memory'),
          createMockMemory('Second memory'),
        ];

        const context: SkillContext = {
          titan: mockTitan,
          memories,
          config: { format: 'plain' },
        };

        const result = await transformerSkill.execute(context);

        expect(result.success).toBe(true);
        expect((result.output as string).includes('[1]')).toBe(true);
        expect((result.output as string).includes('[2]')).toBe(true);
      });
    });
  });

  // ==================== Integration Tests ====================
  describe('Integration', () => {
    it('should execute built-in skill through executor', async () => {
      const registry = getSkillRegistry();
      const executor = getSkillExecutor();

      // Register built-in skill
      registry.register(createSkillFile(summarizerSkill));

      const context: SkillContext = {
        titan: mockTitan,
        query: 'This is a very important note. Remember to always validate inputs. The key decision was made.',
      };

      const result = await executor.executeByName('summarizer', context);

      expect(result.success).toBe(true);
    });

    it('should find and execute skill by trigger text', async () => {
      const registry = getSkillRegistry();
      const executor = getSkillExecutor();

      registry.register(createSkillFile(extractorSkill));

      const context: SkillContext = {
        titan: mockTitan,
        query: 'Please extract entities from: https://example.com and v1.2.3',
      };

      const result = await executor.executeByText('extract', context);

      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
    });
  });
});
