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
        // Simple value
        let parsedValue: unknown = value.replace(/^["']|["']$/g, '');
        // Try to parse numbers and booleans
        if (parsedValue === 'true') parsedValue = true;
        else if (parsedValue === 'false') parsedValue = false;
        else if (!isNaN(Number(parsedValue)) && parsedValue !== '') {
          parsedValue = Number(parsedValue);
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
  const name = metadata.name as string;
  const version = (metadata.version as string) || '1.0.0';
  const description = (metadata.description as string) || '';
  const triggers = (metadata.triggers as string[]) || [];

  if (!name) {
    throw new Error('Skill metadata must include a name');
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

let importSequence = 0;

/**
 * Import a skill module so that an edited file is evaluated again.
 *
 * The query string makes the ES module loader treat the URL as a new module.
 * That is not enough for a CommonJS file: Node serves it from require.cache,
 * which is keyed by file name and ignores the query, so the old exports would
 * come back. Its cache entry is dropped first. Modules the skill itself
 * requires stay cached.
 */
async function importFresh(loadPath: string): Promise<unknown> {
  try {
    delete require.cache[require.resolve(loadPath)];
  } catch {
    // Not resolvable through require: nothing can be cached under that name.
  }

  importSequence += 1;
  const fileUrl = pathToFileURL(loadPath).href;
  return import(`${fileUrl}?t=${Date.now()}-${importSequence}`);
}

/**
 * Find the skill in an imported module.
 *
 * import() of a CommonJS file puts its module.exports under `default`. So a
 * skill assigned to module.exports is at `default`, and a compiled
 * `export default skill` or `export const skill` is one level further down.
 */
function resolveSkillExport(loaded: unknown): TitanSkill | undefined {
  const namespace = (loaded ?? {}) as Record<string, unknown>;
  const commonJsExports = (namespace.default ?? {}) as Record<string, unknown>;
  const candidates = [
    namespace.default,
    commonJsExports.default,
    commonJsExports.skill,
    namespace.skill,
    namespace,
  ];

  return candidates.find(
    (candidate) => typeof (candidate as Partial<TitanSkill> | undefined)?.execute === 'function'
  ) as TitanSkill | undefined;
}

export interface SkillLoadOptions {
  /**
   * Asked once per load, with the absolute path of the file whose content is
   * about to be used: the file itself for a .js or .skill.md file, the
   * compiled .js file for a .ts file. Return false to refuse it. The file is
   * then neither read nor imported and the load returns null.
   */
  allowLoadPath?: (loadPath: string) => boolean;
}

/**
 * The file to import for a .ts or .js skill file: the file itself for .js,
 * the compiled version in dist/skills or next to it for .ts. Returns null
 * when a .ts file has no compiled version.
 */
function selectLoadPath(absolutePath: string): string | null {
  if (path.extname(absolutePath) !== '.ts') {
    return absolutePath;
  }

  const jsPath = absolutePath.replace(/\.ts$/, '.js');
  const distPath = path.normalize(
    absolutePath.replace(/src[/\\]skills/, 'dist/skills').replace(/\.ts$/, '.js')
  );

  if (fs.existsSync(distPath)) {
    return distPath;
  }
  return fs.existsSync(jsPath) ? jsPath : null;
}

function isLoadPathRefused(loadPath: string, options: SkillLoadOptions): boolean {
  if (!options.allowLoadPath || options.allowLoadPath(loadPath)) {
    return false;
  }
  console.warn(`Skill file refused, not loaded: ${loadPath}`);
  return true;
}

/**
 * Load a skill from a file path
 */
export async function loadSkillFromFile(
  filePath: string,
  options: SkillLoadOptions = {}
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
      const loadPath = selectLoadPath(absolutePath);
      if (loadPath === null) {
        console.warn(`No compiled version found for ${absolutePath}`);
        return null;
      }
      if (isLoadPathRefused(loadPath, options)) {
        return null;
      }

      // Dynamic import, evaluated again on every call so hot reload sees edits
      const module = await importFresh(loadPath);

      // Get skill from default export or named export
      const skill = resolveSkillExport(module);

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
      if (isLoadPathRefused(absolutePath, options)) {
        return null;
      }

      const content = fs.readFileSync(absolutePath, 'utf-8');
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
 * Reload a specific skill.
 *
 * The version registered for this path is unregistered first, also when the
 * new version then fails to load. A disabled skill stays disabled: the
 * registry remembers its name, and a file whose skill was disabled is
 * registered as disabled even when the edit gave the skill another name.
 */
export async function reloadSkill(
  skillPath: string,
  options: SkillLoadOptions = {}
): Promise<SkillFile | null> {
  const registry = getSkillRegistry();
  let wasDisabled = false;

  // Find and unregister existing skill with this path
  for (const metadata of registry.list()) {
    const file = registry.getFile(metadata.name);
    if (file && file.path === skillPath) {
      wasDisabled = !file.enabled;
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
  const skillFile = await loadSkillFromFile(skillPath, options);
  if (skillFile) {
    if (wasDisabled) {
      skillFile.enabled = false;
    }
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
