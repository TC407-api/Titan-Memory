/**
 * Titan Memory Skill Loader
 * Dynamic loading/unloading of skills with YAML frontmatter parsing
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  TitanSkill,
  SkillFile,
  SkillMetadata,
  SkillLoaderOptions,
} from './types.js';
import { getSkillRegistry } from './registry.js';

// Simple YAML frontmatter parser (no external dependency)
function parseFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const yamlContent = match[1];
  const body = match[2];

  // Parse simple YAML (key: value format)
  const metadata: Record<string, unknown> = {};
  const lines = yamlContent.split('\n');

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item
    if (trimmed.startsWith('- ') && currentKey && currentArray) {
      currentArray.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      // Save previous array if exists
      if (currentKey && currentArray) {
        metadata[currentKey] = currentArray;
      }

      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      if (value === '' || value === '[]') {
        // Start of array
        currentKey = key;
        currentArray = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array
        const items = value.slice(1, -1).split(',').map(s =>
          s.trim().replace(/^["']|["']$/g, '')
        ).filter(s => s);
        metadata[key] = items;
        currentKey = null;
        currentArray = null;
      } else {
        // Simple value. A quoted value stays the string it spells; only a
        // bare value is read as a boolean or a number.
        const isQuoted = /^(["']).*\1$/.test(value);
        let parsedValue: unknown = value.replace(/^["']|["']$/g, '');
        if (!isQuoted) {
          if (parsedValue === 'true') parsedValue = true;
          else if (parsedValue === 'false') parsedValue = false;
          else if (!isNaN(Number(parsedValue)) && parsedValue !== '') {
            parsedValue = Number(parsedValue);
          }
        }
        metadata[key] = parsedValue;
        currentKey = null;
        currentArray = null;
      }
    }
  }

  // Save last array if exists
  if (currentKey && currentArray) {
    metadata[currentKey] = currentArray;
  }

  return { metadata, body };
}

/**
 * Validate skill metadata
 */
function validateMetadata(metadata: Record<string, unknown>): SkillMetadata {
  const name = metadata.name;
  const version = (metadata.version as string) || '1.0.0';
  const description = (metadata.description as string) || '';
  const triggers = (metadata.triggers as string[]) || [];

  // The registry is keyed by the name, so it must be a string: a bare
  // `name: 2026` would be registered under a number no caller can look up.
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('Skill metadata must include a name (a non-empty string)');
  }

  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new Error('Skill metadata must include at least one trigger');
  }

  return {
    name,
    version,
    description,
    triggers,
    author: metadata.author as string | undefined,
    tags: metadata.tags as string[] | undefined,
    dependencies: metadata.dependencies as string[] | undefined,
    config: metadata.config as Record<string, unknown> | undefined,
  };
}

// fs.constants has no O_NONBLOCK on Windows, which has no FIFOs either.
const OPEN_WITHOUT_BLOCKING = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Read a file as UTF-8 text, or return null when it is not a regular file.
 *
 * Opened without blocking, so a FIFO or a device cannot hold up the process
 * waiting for a writer. The type is checked on the opened descriptor and the
 * text is read from that same descriptor, so a path that is replaced after
 * an earlier check cannot bring a FIFO in.
 */
function readRegularFileText(filePath: string): string | null {
  const fd = fs.openSync(filePath, OPEN_WITHOUT_BLOCKING);
  try {
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, 'utf-8') : null;
  } finally {
    fs.closeSync(fd);
  }
}

export interface LoadSkillOptions {
  /**
   * Throw a file system error (one with a `code`, from stat, open or read)
   * instead of returning null, so a caller can tell a file that could not
   * be read right now from one whose content is not a skill. Default false.
   */
  throwFileSystemErrors?: boolean;
}

/** True for an error from a file system call (it has a string `code` and a `syscall`). */
function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  const candidate = error as NodeJS.ErrnoException | null;
  return typeof candidate?.code === 'string' && typeof candidate.syscall === 'string';
}

/**
 * Load a skill from a file path. Returns null when the file is not a skill
 * or cannot be loaded; see LoadSkillOptions for file system errors.
 */
export async function loadSkillFromFile(
  filePath: string,
  options: LoadSkillOptions = {}
): Promise<SkillFile | null> {
  try {
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      console.warn(`Skill file not found: ${absolutePath}`);
      return null;
    }

    const stats = fs.statSync(absolutePath);
    const ext = path.extname(absolutePath);

    // Handle TypeScript/JavaScript files
    if (ext === '.ts' || ext === '.js') {
      // For compiled skills, we need to load the .js version
      let loadPath = absolutePath;
      if (ext === '.ts') {
        // Look for compiled version in dist or same directory
        const jsPath = absolutePath.replace(/\.ts$/, '.js');
        const distPath = absolutePath.replace(/src[/\\]skills/, 'dist/skills').replace(/\.ts$/, '.js');

        if (fs.existsSync(distPath)) {
          loadPath = distPath;
        } else if (fs.existsSync(jsPath)) {
          loadPath = jsPath;
        } else {
          console.warn(`No compiled version found for ${absolutePath}`);
          return null;
        }
      }

      // Dynamic import
      const fileUrl = pathToFileURL(loadPath).href;
      // Add cache buster for hot reload
      const cacheBuster = `?t=${Date.now()}`;
      const module = await import(fileUrl + cacheBuster);

      // Get skill from default export or named export
      const skill: TitanSkill = module.default || module.skill || module;

      if (!skill || typeof skill.execute !== 'function') {
        console.warn(`Invalid skill module: ${filePath} (missing execute function)`);
        return null;
      }

      // Validate metadata
      if (!skill.metadata) {
        console.warn(`Invalid skill module: ${filePath} (missing metadata)`);
        return null;
      }

      const metadata = validateMetadata(skill.metadata as unknown as Record<string, unknown>);

      return {
        path: absolutePath,
        metadata,
        skill: { ...skill, metadata },
        loadedAt: new Date(),
        lastModified: stats.mtime,
        enabled: true,
      };
    }

    // Handle .skill.md or .skill.ts files with frontmatter
    if (absolutePath.includes('.skill.')) {
      const content = readRegularFileText(absolutePath);
      if (content === null) {
        console.warn(`Skill file is not a regular file: ${filePath}`);
        return null;
      }
      const { metadata: rawMetadata } = parseFrontmatter(content);

      if (Object.keys(rawMetadata).length === 0) {
        console.warn(`No frontmatter found in skill file: ${filePath}`);
        return null;
      }

      const metadata = validateMetadata(rawMetadata);

      // For markdown skills, we create a simple pass-through skill
      const skill: TitanSkill = {
        metadata,
        async execute(_context) {
          return {
            success: true,
            output: `Skill ${metadata.name} executed`,
            metadata: { executionTimeMs: 0 },
          };
        },
      };

      return {
        path: absolutePath,
        metadata,
        skill,
        loadedAt: new Date(),
        lastModified: stats.mtime,
        enabled: true,
      };
    }

    console.warn(`Unsupported skill file format: ${filePath}`);
    return null;
  } catch (error) {
    if (options.throwFileSystemErrors && isFileSystemError(error)) {
      throw error;
    }
    console.error(`Error loading skill from ${filePath}:`, error);
    return null;
  }
}

/**
 * Load all skills from a directory
 */
export async function loadSkillsFromDirectory(
  directory: string,
  options: Partial<SkillLoaderOptions> = {}
): Promise<SkillFile[]> {
  const {
    patterns = ['**/*.skill.ts', '**/*.skill.js', '**/built-in/*.ts', '**/built-in/*.js'],
    ignored = ['node_modules', '.disabled', 'dist'],
  } = options;

  const loadedSkills: SkillFile[] = [];
  const registry = getSkillRegistry();

  if (!fs.existsSync(directory)) {
    console.warn(`Skills directory not found: ${directory}`);
    return loadedSkills;
  }

  // Simple glob implementation
  function walkDir(dir: string, baseDir: string): string[] {
    const files: string[] = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);

        // Check if ignored
        if (ignored.some(pattern => relativePath.includes(pattern))) {
          continue;
        }

        if (entry.isDirectory()) {
          files.push(...walkDir(fullPath, baseDir));
        } else if (entry.isFile()) {
          // Check if matches any pattern
          const matchesPattern = patterns.some(pattern => {
            if (pattern.includes('**')) {
              const suffix = pattern.replace('**/', '');
              return entry.name.endsWith(suffix.replace('*', ''));
            }
            return entry.name.match(new RegExp(pattern.replace('*', '.*')));
          });

          if (matchesPattern) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.warn(`Error walking directory ${dir}:`, error);
    }

    return files;
  }

  const skillFiles = walkDir(directory, directory);

  for (const filePath of skillFiles) {
    const skillFile = await loadSkillFromFile(filePath);
    if (skillFile) {
      registry.register(skillFile);
      loadedSkills.push(skillFile);
    }
  }

  registry.markReload();

  return loadedSkills;
}

/**
 * Reload a specific skill
 */
export async function reloadSkill(skillPath: string): Promise<SkillFile | null> {
  const registry = getSkillRegistry();

  // Find and unregister existing skill with this path
  for (const metadata of registry.list()) {
    const file = registry.getFile(metadata.name);
    if (file && file.path === skillPath) {
      // Call onUnload if defined
      if (file.skill.onUnload) {
        try {
          await file.skill.onUnload();
        } catch (error) {
          console.warn(`Error in skill onUnload for ${metadata.name}:`, error);
        }
      }
      registry.unregister(metadata.name);
      break;
    }
  }

  // Load fresh
  const skillFile = await loadSkillFromFile(skillPath);
  if (skillFile) {
    // Call onLoad if defined
    if (skillFile.skill.onLoad) {
      try {
        await skillFile.skill.onLoad();
      } catch (error) {
        console.warn(`Error in skill onLoad for ${skillFile.metadata.name}:`, error);
      }
    }
    registry.register(skillFile);
  }

  return skillFile;
}

/**
 * Unload a skill by name
 */
export async function unloadSkill(name: string): Promise<boolean> {
  const registry = getSkillRegistry();
  const file = registry.getFile(name);

  if (!file) {
    return false;
  }

  // Call onUnload if defined
  if (file.skill.onUnload) {
    try {
      await file.skill.onUnload();
    } catch (error) {
      console.warn(`Error in skill onUnload for ${name}:`, error);
    }
  }

  return registry.unregister(name);
}

/**
 * Get default skills directory
 */
export function getDefaultSkillsDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.claude', 'titan-memory', 'skills');
}

/**
 * Ensure skills directory exists
 */
export function ensureSkillsDirectory(dir?: string): string {
  const skillsDir = dir || getDefaultSkillsDir();

  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Create subdirectories
  const builtInDir = path.join(skillsDir, 'built-in');
  const customDir = path.join(skillsDir, 'custom');
  const disabledDir = path.join(skillsDir, '.disabled');

  for (const subDir of [builtInDir, customDir, disabledDir]) {
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true });
    }
  }

  return skillsDir;
}
