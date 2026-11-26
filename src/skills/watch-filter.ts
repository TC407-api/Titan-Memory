/**
 * Titan Memory Skill Watch Filter
 *
 * chokidar 4 removed glob support. A glob string given to watch() or to its
 * `ignored` option is compared literally, so it never matches anything and
 * the watcher reports no events. The skill watcher therefore watches the
 * skills directory itself and decides here which paths it cares about.
 */

import path from 'path';

export interface WatchFilterOptions {
  /** Directory being watched. `patterns` are relative to it. */
  root: string;
  /** Globs for the files to report, relative to `root`. */
  patterns: string[];
  /** Globs for files and directories to skip, relative to `root` or absolute. */
  ignored: string[];
}

/** The part of fs.Stats the filter needs. */
export interface PathKind {
  isFile(): boolean;
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
 */
export function createWatchFilter(options: WatchFilterOptions): WatchFilter {
  const root = path.resolve(options.root);
  const wanted = options.patterns.map(globToRegExp);
  const unwanted = options.ignored.map(globToRegExp);

  return (candidatePath, stats) => {
    const absolutePath = path.resolve(candidatePath);
    const relativePath = toPosixPath(path.relative(root, absolutePath));
    if (relativePath === '') {
      return false;
    }

    const absolutePosixPath = splitSegments(absolutePath).join('/');
    if (matchesAny(unwanted, relativePath) || matchesAny(unwanted, absolutePosixPath)) {
      return true;
    }

    return stats?.isFile() === true && !matchesAny(wanted, relativePath);
  };
}
