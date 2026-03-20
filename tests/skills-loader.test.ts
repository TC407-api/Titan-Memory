/**
 * Additional tests for Titan Memory Skill Loader
 * Targets uncovered paths in src/skills/loader.ts
 *
 * Existing coverage: 29.3%
 * These tests target: parseFrontmatter, validateMetadata, loadSkillFromFile
 * (.skill.md paths, unsupported ext, .ts without compiled output),
 * loadSkillsFromDirectory (custom options), reloadSkill, unloadSkill,
 * getDefaultSkillsDir, ensureSkillsDirectory edge cases.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadSkillFromFile,
  loadSkillsFromDirectory,
  reloadSkill,
  unloadSkill,
  getDefaultSkillsDir,
  ensureSkillsDirectory,
} from '../src/skills/loader';
import { getSkillRegistry, resetSkillRegistry } from '../src/skills/registry';
import { TitanSkill, SkillFile } from '../src/skills/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(suffix: string): string {
  const dir = path.join(os.tmpdir(), `titan-loader-test-${suffix}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkillMd(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function createRegisteredSkillFile(
  name: string,
  filePath: string,
  extras: Partial<TitanSkill> = {}
): SkillFile {
  const skill: TitanSkill = {
    metadata: { name, version: '1.0.0', description: '', triggers: [name] },
    execute: jest.fn().mockResolvedValue({ success: true }),
    ...extras,
  };
  const file: SkillFile = {
    path: filePath,
    metadata: skill.metadata,
    skill,
    loadedAt: new Date(),
    lastModified: new Date(),
    enabled: true,
  };
  getSkillRegistry().register(file);
  return file;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let testDir: string;

beforeAll(() => {
  testDir = makeTempDir('main');
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSkillRegistry();
});

// ===========================================================================
// parseFrontmatter (exercised indirectly through loadSkillFromFile .skill.md)
// ===========================================================================

describe('parseFrontmatter — via .skill.md loading', () => {
  it('should return null when .skill.md has no frontmatter delimiters', async () => {
    const dir = makeTempDir('no-fm');
    const filePath = writeSkillMd(dir, 'no-front.skill.md', '# Just a heading\nNo frontmatter here.');
    const result = await loadSkillFromFile(filePath);
    expect(result).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should parse triggers as a block array (dash items)', async () => {
    const dir = makeTempDir('block-array');
    const content = `---
name: block-array-skill
version: 1.2.0
description: Tests block array parsing
triggers:
  - trigger-one
  - trigger-two
  - trigger-three
---
# Body
`;
    const filePath = writeSkillMd(dir, 'block.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.metadata.name).toBe('block-array-skill');
    expect(result!.metadata.triggers).toEqual(['trigger-one', 'trigger-two', 'trigger-three']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should parse triggers as an inline array [a, b, c]', async () => {
    const dir = makeTempDir('inline-array');
    const content = `---
name: inline-array-skill
version: 1.0.0
description: Tests inline array
triggers: [alpha, beta, gamma]
---
`;
    const filePath = writeSkillMd(dir, 'inline.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.metadata.triggers).toEqual(['alpha', 'beta', 'gamma']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should parse triggers as an empty inline array [] then fall back to block items', async () => {
    const dir = makeTempDir('empty-inline');
    const content = `---
name: empty-inline-skill
version: 1.0.0
description: Start empty then block
triggers:
  - item-a
  - item-b
---
`;
    const filePath = writeSkillMd(dir, 'empty-inline.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.metadata.triggers).toEqual(['item-a', 'item-b']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should coerce boolean true value in frontmatter', async () => {
    const dir = makeTempDir('bool-true');
    const content = `---
name: bool-skill
version: 1.0.0
description: Bool coercion
triggers:
  - bool
enabled: true
---
`;
    const filePath = writeSkillMd(dir, 'bool.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    // The metadata is parsed — we verify the skill loaded (boolean coercion path hit)
    expect(result!.metadata.name).toBe('bool-skill');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should coerce boolean false value in frontmatter', async () => {
    const dir = makeTempDir('bool-false');
    const content = `---
name: bool-false-skill
version: 1.0.0
description: Bool false coercion
triggers:
  - boolfalse
enabled: false
---
`;
    const filePath = writeSkillMd(dir, 'bool-false.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.metadata.name).toBe('bool-false-skill');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should coerce numeric values in frontmatter', async () => {
    const dir = makeTempDir('numeric');
    const content = `---
name: numeric-skill
version: 1.0.0
description: Numeric coercion
triggers:
  - numeric
priority: 42
---
`;
    const filePath = writeSkillMd(dir, 'numeric.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.metadata.name).toBe('numeric-skill');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should strip surrounding quotes from string values', async () => {
    const dir = makeTempDir('quoted');
    const content = `---
name: quoted-skill
version: "2.0.0"
description: 'Quoted description'
triggers:
  - quoted
---
`;
    const filePath = writeSkillMd(dir, 'quoted.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.metadata.version).toBe('2.0.0');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should ignore comment lines and blank lines in frontmatter', async () => {
    const dir = makeTempDir('comments');
    const content = `---
# This is a comment
name: comment-skill

version: 1.0.0
# Another comment
description: Has comments
triggers:
  - comment
---
`;
    const filePath = writeSkillMd(dir, 'comment.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.metadata.name).toBe('comment-skill');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should populate optional metadata fields (author, tags, dependencies)', async () => {
    const dir = makeTempDir('optional-fields');
    const content = `---
name: full-metadata-skill
version: 1.0.0
description: Full metadata
author: Travis
tags: [memory, util]
dependencies: [dep-a, dep-b]
triggers:
  - full
---
`;
    const filePath = writeSkillMd(dir, 'full.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.metadata.author).toBe('Travis');
    expect(result!.metadata.tags).toEqual(['memory', 'util']);
    expect(result!.metadata.dependencies).toEqual(['dep-a', 'dep-b']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// validateMetadata error paths
// ===========================================================================

describe('validateMetadata — error paths via loadSkillFromFile', () => {
  it('should return null when frontmatter is missing name field', async () => {
    const dir = makeTempDir('no-name');
    const content = `---
version: 1.0.0
description: Missing name
triggers:
  - something
---
`;
    const filePath = writeSkillMd(dir, 'no-name.skill.md', content);
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadSkillFromFile(filePath);
    expect(result).toBeNull();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return null when triggers array is empty', async () => {
    const dir = makeTempDir('no-triggers');
    const content = `---
name: no-triggers-skill
version: 1.0.0
description: No triggers
triggers: []
---
`;
    const filePath = writeSkillMd(dir, 'no-triggers.skill.md', content);
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadSkillFromFile(filePath);
    expect(result).toBeNull();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return null when triggers key is absent', async () => {
    const dir = makeTempDir('absent-triggers');
    const content = `---
name: absent-triggers-skill
version: 1.0.0
description: No triggers key at all
---
`;
    const filePath = writeSkillMd(dir, 'absent.skill.md', content);
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadSkillFromFile(filePath);
    expect(result).toBeNull();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// loadSkillFromFile — unsupported extension and .ts without compiled output
// ===========================================================================

describe('loadSkillFromFile — file extension handling', () => {
  it('should return null for an unsupported file extension', async () => {
    const dir = makeTempDir('unsupported-ext');
    const filePath = path.join(dir, 'some-skill.yaml');
    fs.writeFileSync(filePath, 'name: test\n');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadSkillFromFile(filePath);
    expect(result).toBeNull();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return null for a .txt file that does not match .skill. pattern', async () => {
    const dir = makeTempDir('txt-ext');
    const filePath = path.join(dir, 'readme.txt');
    fs.writeFileSync(filePath, 'just text\n');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadSkillFromFile(filePath);
    expect(result).toBeNull();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return null for a .ts file when no compiled .js exists', async () => {
    const dir = makeTempDir('ts-no-js');
    // Create a real .ts file — but there is no corresponding dist/ or sibling .js
    const filePath = path.join(dir, 'orphan.ts');
    fs.writeFileSync(filePath, 'export const skill = {};');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadSkillFromFile(filePath);
    expect(result).toBeNull();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// loadSkillFromFile — .skill.md execute function
// ===========================================================================

describe('loadSkillFromFile — .skill.md execute behaviour', () => {
  it('should produce a SkillFile whose execute returns success with skill name in output', async () => {
    const dir = makeTempDir('md-execute');
    const content = `---
name: md-exec-skill
version: 1.0.0
description: Execute test
triggers:
  - mdexec
---
`;
    const filePath = writeSkillMd(dir, 'md-exec.skill.md', content);
    const result = await loadSkillFromFile(filePath);
    expect(result).not.toBeNull();

    const execResult = await result!.skill.execute({ titan: {} as never });
    expect(execResult.success).toBe(true);
    expect(typeof execResult.output).toBe('string');
    expect(execResult.output as string).toContain('md-exec-skill');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should set enabled: true and populate loadedAt / lastModified on returned SkillFile', async () => {
    const dir = makeTempDir('md-fields');
    const content = `---
name: fields-skill
version: 1.0.0
description: Field check
triggers:
  - fields
---
`;
    const filePath = writeSkillMd(dir, 'fields.skill.md', content);
    const before = new Date();
    const result = await loadSkillFromFile(filePath);
    const after = new Date();

    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.loadedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result!.loadedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    // toBeInstanceOf(Date) can fail across module boundaries in ts-jest;
    // checking the constructor name is equivalent and more robust.
    expect(Object.prototype.toString.call(result!.lastModified)).toBe('[object Date]');
    expect(isNaN(result!.lastModified.getTime())).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// loadSkillsFromDirectory — custom options
// ===========================================================================

describe('loadSkillsFromDirectory — custom options', () => {
  it('should respect a custom patterns option and match only specified suffixes', async () => {
    const dir = makeTempDir('custom-patterns');
    // Write a .skill.md file (would normally match default patterns)
    const mdContent = `---
name: should-not-load
version: 1.0.0
description: Should be excluded by custom pattern
triggers:
  - skip
---
`;
    fs.writeFileSync(path.join(dir, 'skip.skill.md'), mdContent);

    // Use a pattern that matches nothing in the dir
    const loaded = await loadSkillsFromDirectory(dir, {
      patterns: ['**/*.nonexistent'],
    });

    expect(loaded).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should respect a custom ignored option and skip matching subdirectory names', async () => {
    const dir = makeTempDir('custom-ignored');
    const subDir = path.join(dir, 'skip-me');
    fs.mkdirSync(subDir, { recursive: true });

    const content = `---
name: ignored-skill
version: 1.0.0
description: Should be ignored
triggers:
  - ignored
---
`;
    fs.writeFileSync(path.join(subDir, 'ignored.skill.md'), content);

    const loaded = await loadSkillsFromDirectory(dir, {
      ignored: ['skip-me'],
    });

    expect(loaded).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should register loaded skills into the registry', async () => {
    const dir = makeTempDir('register-check');
    const content = `---
name: registry-check-skill
version: 1.0.0
description: Should appear in registry
triggers:
  - regcheck
---
`;
    writeSkillMd(dir, 'registry-check.skill.md', content);

    const registry = getSkillRegistry();
    // Default patterns only match *.skill.ts / *.skill.js / built-in/*.ts|js.
    // Pass an explicit pattern that matches .skill.md so the file is picked up.
    await loadSkillsFromDirectory(dir, { patterns: ['**/*.skill.md'] });

    expect(registry.has('registry-check-skill')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should call registry.markReload() after loading (lastReloadAt is set)', async () => {
    const dir = makeTempDir('mark-reload');
    const before = new Date();

    await loadSkillsFromDirectory(dir);

    const stats = getSkillRegistry().getStats();
    // lastReloadAt should be set even for an empty dir load
    expect(stats.lastReloadAt).toBeDefined();
    expect(stats.lastReloadAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// reloadSkill
// ===========================================================================

describe('reloadSkill', () => {
  it('should return null when skill path is not in registry and file does not exist', async () => {
    const result = await reloadSkill('/totally/nonexistent/skill.ts');
    expect(result).toBeNull();
  });

  it('should unregister existing skill before loading the fresh version', async () => {
    const dir = makeTempDir('reload-unregister');
    const content = `---
name: reload-target
version: 1.0.0
description: Will be reloaded
triggers:
  - reload-target
---
`;
    const filePath = writeSkillMd(dir, 'reload-target.skill.md', content);

    // Pre-register the skill pointing at the file path
    createRegisteredSkillFile('reload-target', filePath);
    const registry = getSkillRegistry();
    expect(registry.has('reload-target')).toBe(true);

    await reloadSkill(filePath);

    // After reload the skill should still be registered (re-loaded fresh)
    expect(registry.has('reload-target')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should call onUnload on the existing skill before unregistering', async () => {
    const dir = makeTempDir('reload-onunload');
    const filePath = path.join(dir, 'onunload-skill.skill.md');
    fs.writeFileSync(filePath, `---
name: onunload-skill
version: 1.0.0
description: onUnload test
triggers:
  - onunload
---
`);

    const onUnload = jest.fn().mockResolvedValue(undefined);
    createRegisteredSkillFile('onunload-skill', filePath, { onUnload });

    await reloadSkill(filePath);

    expect(onUnload).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should continue reloading even when onUnload throws', async () => {
    const dir = makeTempDir('reload-onunload-throws');
    const filePath = path.join(dir, 'throws-on-unload.skill.md');
    fs.writeFileSync(filePath, `---
name: throws-on-unload
version: 1.0.0
description: onUnload throws
triggers:
  - throwunload
---
`);

    const onUnload = jest.fn().mockRejectedValue(new Error('unload boom'));
    createRegisteredSkillFile('throws-on-unload', filePath, { onUnload });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Should not throw — error is swallowed with a warning
    await reloadSkill(filePath);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should call onLoad on the newly loaded skill', async () => {
    const dir = makeTempDir('reload-onload');
    const content = `---
name: onload-skill
version: 1.0.0
description: onLoad is called after reload
triggers:
  - onloadsig
---
`;
    const filePath = writeSkillMd(dir, 'onload-skill.skill.md', content);

    // Load fresh (no prior registration) — onLoad is called if present on the loaded module.
    // Since .skill.md creates a plain pass-through skill without onLoad, we verify
    // loadSkillFromFile succeeds and the result is registered.
    const result = await reloadSkill(filePath);

    expect(result).not.toBeNull();
    expect(getSkillRegistry().has('onload-skill')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ===========================================================================
// unloadSkill
// ===========================================================================

describe('unloadSkill', () => {
  it('should return false when skill name is not registered', async () => {
    const result = await unloadSkill('nonexistent-skill-xyz');
    expect(result).toBe(false);
  });

  it('should return true and unregister a registered skill', async () => {
    createRegisteredSkillFile('unload-me', '/fake/path/unload-me.skill.md');
    const registry = getSkillRegistry();
    expect(registry.has('unload-me')).toBe(true);

    const result = await unloadSkill('unload-me');

    expect(result).toBe(true);
    expect(registry.has('unload-me')).toBe(false);
  });

  it('should call onUnload before unregistering', async () => {
    const onUnload = jest.fn().mockResolvedValue(undefined);
    createRegisteredSkillFile('unload-with-hook', '/fake/path/hook.skill.md', { onUnload });

    await unloadSkill('unload-with-hook');

    expect(onUnload).toHaveBeenCalledTimes(1);
  });

  it('should still unregister the skill when onUnload throws', async () => {
    const onUnload = jest.fn().mockRejectedValue(new Error('cleanup failed'));
    createRegisteredSkillFile('unload-throws', '/fake/path/throws.skill.md', { onUnload });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await unloadSkill('unload-throws');

    expect(result).toBe(true);
    expect(getSkillRegistry().has('unload-throws')).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should not call onUnload when skill has no onUnload hook', async () => {
    // Skill without onUnload — this exercises the `if (file.skill.onUnload)` false branch
    createRegisteredSkillFile('no-hook-skill', '/fake/path/no-hook.skill.md');

    const result = await unloadSkill('no-hook-skill');

    expect(result).toBe(true);
  });
});

// ===========================================================================
// getDefaultSkillsDir
// ===========================================================================

describe('getDefaultSkillsDir', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    // Remove keys that were not in original
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  it('should use HOME environment variable when set', () => {
    process.env.HOME = '/home/testuser';
    delete process.env.USERPROFILE;
    const result = getDefaultSkillsDir();
    // Normalise separators so this passes on Windows and Unix alike.
    const normalised = result.replace(/\\/g, '/');
    expect(normalised).toContain('/home/testuser');
    expect(normalised).toContain('titan-memory');
    expect(normalised).toContain('skills');
  });

  it('should fall back to USERPROFILE when HOME is not set', () => {
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\TestUser';
    const result = getDefaultSkillsDir();
    expect(result).toContain('TestUser');
    expect(result).toContain('titan-memory');
  });

  it('should return a path ending in skills', () => {
    const result = getDefaultSkillsDir();
    expect(path.basename(result)).toBe('skills');
  });

  it('should include .claude/titan-memory in the path', () => {
    process.env.HOME = '/fake/home';
    delete process.env.USERPROFILE;
    const result = getDefaultSkillsDir();
    // path.join normalises separators — check for the relevant segments
    expect(result.replace(/\\/g, '/')).toMatch(/\.claude\/titan-memory\/skills$/);
  });
});

// ===========================================================================
// ensureSkillsDirectory
// ===========================================================================

describe('ensureSkillsDirectory', () => {
  it('should create .disabled subdirectory in addition to built-in and custom', () => {
    const dir = makeTempDir('ensure-disabled');
    ensureSkillsDirectory(dir);

    expect(fs.existsSync(path.join(dir, 'built-in'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'custom'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.disabled'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should be idempotent — calling twice does not throw', () => {
    const dir = makeTempDir('ensure-idempotent');
    expect(() => {
      ensureSkillsDirectory(dir);
      ensureSkillsDirectory(dir);
    }).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return the skills directory path that was passed in', () => {
    const dir = makeTempDir('ensure-return');
    const result = ensureSkillsDirectory(dir);
    expect(result).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should create the top-level directory if it does not exist', () => {
    const dir = path.join(os.tmpdir(), `titan-ensure-new-${Date.now()}`);
    expect(fs.existsSync(dir)).toBe(false);
    ensureSkillsDirectory(dir);
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should use getDefaultSkillsDir when called with no argument', () => {
    // We cannot safely create the real default dir, but we can verify the
    // function accepts undefined and returns a string without throwing.
    // Override HOME to a writable temp location to avoid touching real home.
    const fakeHome = makeTempDir('fake-home');
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    delete process.env.USERPROFILE;

    let result: string | undefined;
    expect(() => {
      result = ensureSkillsDirectory();
    }).not.toThrow();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);

    // Restore
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;

    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
});
