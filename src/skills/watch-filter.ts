/**
 * Titan Memory Skill Watch Filter
 *
 * chokidar 4 removed glob support. A glob string given to watch() or to its
 * `ignored` option is compared literally, so it never matches anything and
 * the watcher reports no events. The skill watcher therefore watches the
 * skills directory itself and decides here which paths it cares about.
 */

import fs from 'fs';
import path from 'path';

export interface WatchFilterOptions {
  /** Directory being watched. `patterns` are relative to it. */
  root: string;
  /** Globs for the files to report, relative to `root`. */
  patterns: string[];
  /**
   * Globs for files and directories to skip. A relative glob is matched
   * against the path relative to `root`, so the directories above `root`
   * never count. An absolute glob is matched against the absolute path.
   */
  ignored: string[];
}

/** The part of fs.Stats the filter needs. */
export interface PathKind {
  isFile(): boolean;
  isSymbolicLink?(): boolean;
}

/** Returns true when the watcher should skip the path. */
export type WatchFilter = (candidatePath: string, stats?: PathKind) => boolean;

const REGEXP_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g;

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function splitSegments(value: string): string[] {
  return toPosixPath(value)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

function convertSegment(segment: string): string {
  return segment
    .replace(REGEXP_SPECIAL_CHARS, '\\$&')
    .replace(/\*+/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

/**
 * Convert a glob to a RegExp that is tested against a `/`-separated path.
 *
 * Supported: `**` as a whole segment (any number of directories, including
 * none), `*` (any run of characters inside one segment, a leading dot
 * included) and `?` (one character inside a segment). Everything else is
 * literal; braces, character classes and negation are not supported. A
 * trailing `/**` also matches the directory itself, so an ignored directory
 * is skipped without being read. Matching is case sensitive.
 */
export function globToRegExp(glob: string): RegExp {
  const segments = splitSegments(glob);
  const last = segments.length - 1;
  const coversSubtree = last > 0 && segments[last] === '**';
  const body = coversSubtree ? segments.slice(0, last) : segments;

  const source = body
    .map((segment, index) => {
      const isFinal = index === body.length - 1;
      if (segment === '**') {
        return isFinal ? '.*' : '(?:[^/]+/)*';
      }
      return convertSegment(segment) + (isFinal ? '' : '/');
    })
    .join('');

  return new RegExp(`^${source}${coversSubtree ? '(?:/.*)?' : ''}$`);
}

function matchesAny(matchers: RegExp[], value: string): boolean {
  return matchers.some((matcher) => matcher.test(value));
}

/**
 * Build the filter the skill watcher gives to chokidar as `ignored`.
 *
 * chokidar asks about every path twice: first with the path alone, then with
 * its stats. The `patterns` check runs only once a path is known to be a
 * file. Without that, directories would be skipped on the first call and
 * nothing below the root would ever be watched.
 *
 * A symbolic link below the root counts as a file: it is kept when its path
 * matches `patterns`, so the watcher hears about a skill file that has been
 * replaced by a link and can unload that skill. The watcher has chokidar
 * report links without following them, so a linked directory is not walked,
 * just as loadSkillsFromDirectory does not walk one.
 */
export function createWatchFilter(options: WatchFilterOptions): WatchFilter {
  const root = path.resolve(options.root);
  const wanted = options.patterns.map(globToRegExp);
  const relativeGlobs = options.ignored.filter((glob) => !path.isAbsolute(glob));
  const absoluteGlobs = options.ignored.filter((glob) => path.isAbsolute(glob));
  const unwantedBelowRoot = relativeGlobs.map(globToRegExp);
  const unwantedAnywhere = absoluteGlobs.map(globToRegExp);

  return (candidatePath, stats) => {
    const absolutePath = path.resolve(candidatePath);
    const nativeRelativePath = path.relative(root, absolutePath);
    if (nativeRelativePath === '') {
      return false;
    }
    // chokidar turns a backslash into "/" before it asks this filter, and the
    // globs here read it as a separator too, so such a name is skipped
    // whichever way it arrives.
    if (hasBackslashInName(nativeRelativePath)) {
      return true;
    }
    const relativePath = toPosixPath(nativeRelativePath);
    if (
      matchesAny(unwantedBelowRoot, relativePath) ||
      matchesAny(unwantedAnywhere, splitSegments(absolutePath).join('/'))
    ) {
      return true;
    }

    return isFileOrLink(stats) && !matchesAny(wanted, relativePath);
  };
}

/**
 * True where "/" is the only separator (POSIX) and `candidatePath` has a
 * backslash in it, which is then part of a file or directory name. chokidar
 * reads every backslash as a separator, so the skill watcher neither loads
 * such a name nor watches a skills directory whose path has one.
 */
export function hasBackslashInName(candidatePath: string): boolean {
  return path.sep === '/' && candidatePath.includes('\\');
}

/** True when `stats` describes a file or a symbolic link (not a directory). */
export function isFileOrLink(stats?: PathKind): boolean {
  return stats?.isFile() === true || stats?.isSymbolicLink?.() === true;
}

/**
 * True when the file name ends in `.skill.md`: a skill described by front
 * matter. Loading one reads and parses text and evaluates no code. The skill
 * watcher loads these files and no others.
 */
export function isMarkdownSkillFile(filePath: string): boolean {
  return toPosixPath(filePath).split('/').pop()!.endsWith('.skill.md');
}

/**
 * True when `candidatePath` is not a path below `root` that can be reached
 * without going through a symbolic link (or a Windows junction). `root`
 * itself counts: the skill watcher refuses a skills directory that is a
 * link, so one that is a link now was replaced after the watcher started.
 * Links above `root` do not count. A path that cannot be checked counts as
 * crossing one, so the caller leaves it alone.
 *
 * The skill watcher reports a link under its own path, and an event can name
 * a file below a linked directory. Loading either would register a skill
 * from outside the skills directory, which loadSkillsFromDirectory never
 * does.
 *
 * The answer describes the path at the time of the call. The file is opened
 * later, by name, so this is a consistency check and not a guarantee against
 * a process that swaps a link in between the two.
 */
export function crossesSymlink(root: string, candidatePath: string): boolean {
  const state = inspectPath(root, candidatePath);
  return state !== 'file' && state !== 'other';
}

/**
 * What `candidatePath` is, for the checks of crossesSymlink:
 * - 'file': a regular file below `root`, reached without a link;
 * - 'other': below `root` and reached without a link, but not a regular
 *   file (a directory, a FIFO, a device);
 * - 'link': the path is not below `root`, or `root`, the path or a
 *   directory between them is a link;
 * - 'missing': the path or a directory on it does not exist;
 * - 'unknown': it could not be checked (an error other than a missing
 *   entry), so it may be fine a moment later.
 */
export type PathState = 'file' | 'other' | 'link' | 'missing' | 'unknown';

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

export function inspectPath(root: string, candidatePath: string): PathState {
  const rootPath = path.resolve(root);
  const relativePath = path.relative(rootPath, path.resolve(candidatePath));
  const isOutsideRoot =
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  if (relativePath === '' || isOutsideRoot) {
    return 'link';
  }

  let currentPath = rootPath;
  try {
    let stats = fs.lstatSync(rootPath);
    if (stats.isSymbolicLink()) {
      return 'link';
    }
    for (const segment of relativePath.split(path.sep)) {
      currentPath = path.join(currentPath, segment);
      stats = fs.lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        return 'link';
      }
    }
    return stats.isFile() ? 'file' : 'other';
  } catch (error) {
    return MISSING_CODES.has((error as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'unknown';
  }
}
