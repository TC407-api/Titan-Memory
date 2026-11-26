/**
 * Tests for the skill watcher's path filter (src/skills/watch-filter.ts)
 */

import * as path from 'path';
import { createWatchFilter, globToRegExp, PathKind } from '../src/skills/watch-filter';

const FILE: PathKind = { isFile: () => true };
const DIRECTORY: PathKind = { isFile: () => false };

const DEFAULT_PATTERNS = ['**/*.ts', '**/*.js', '**/*.skill.md'];
const DEFAULT_IGNORED = ['**/node_modules/**', '**/.disabled/**', '**/dist/**', '**/*.d.ts'];

describe('globToRegExp', () => {
  it('matches a file pattern at any depth, the top level included', () => {
    const matcher = globToRegExp('**/*.skill.md');

    expect(matcher.test('a.skill.md')).toBe(true);
    expect(matcher.test('custom/a.skill.md')).toBe(true);
    expect(matcher.test('custom/team/a.skill.md')).toBe(true);
    expect(matcher.test('a.skill.md.bak')).toBe(false);
    expect(matcher.test('a.md')).toBe(false);
  });

  it('keeps a single star inside one path segment', () => {
    const matcher = globToRegExp('custom/*.ts');

    expect(matcher.test('custom/a.ts')).toBe(true);
    expect(matcher.test('custom/team/a.ts')).toBe(false);
    expect(matcher.test('a.ts')).toBe(false);
  });

  it('treats a trailing globstar as the directory and everything under it', () => {
    const matcher = globToRegExp('**/node_modules/**');

    expect(matcher.test('node_modules')).toBe(true);
    expect(matcher.test('node_modules/pkg/index.js')).toBe(true);
    expect(matcher.test('custom/node_modules')).toBe(true);
    expect(matcher.test('custom/node_modules/pkg/index.js')).toBe(true);
    expect(matcher.test('node_modules_backup/index.js')).toBe(false);
    expect(matcher.test('my_node_modules')).toBe(false);
  });

  it('matches a globstar in the middle against zero or more directories', () => {
    const matcher = globToRegExp('custom/**/*.skill.md');

    expect(matcher.test('custom/a.skill.md')).toBe(true);
    expect(matcher.test('custom/x/y/a.skill.md')).toBe(true);
    expect(matcher.test('other/a.skill.md')).toBe(false);
  });

  it('matches everything for a lone globstar', () => {
    const matcher = globToRegExp('**');

    expect(matcher.test('a.ts')).toBe(true);
    expect(matcher.test('x/y/a.ts')).toBe(true);
  });

  it('treats a question mark as one character inside a segment', () => {
    const matcher = globToRegExp('v?/*.js');

    expect(matcher.test('v1/a.js')).toBe(true);
    expect(matcher.test('v12/a.js')).toBe(false);
    expect(matcher.test('v/a.js')).toBe(false);
  });

  it('treats regular expression characters as literals', () => {
    expect(globToRegExp('**/*.d.ts').test('types.d.ts')).toBe(true);
    expect(globToRegExp('**/*.d.ts').test('typesXdXts')).toBe(false);
    expect(globToRegExp('a+b(1)/[x].ts').test('a+b(1)/[x].ts')).toBe(true);
    expect(globToRegExp('a+b(1)/[x].ts').test('aab1/x.ts')).toBe(false);
  });

  it('accepts backslash separators, a leading ./ and a trailing slash', () => {
    expect(globToRegExp('custom\\**\\*.ts').test('custom/x/a.ts')).toBe(true);
    expect(globToRegExp('./custom/*.ts').test('custom/a.ts')).toBe(true);
    expect(globToRegExp('custom/drafts/').test('custom/drafts')).toBe(true);
  });
});

describe('createWatchFilter', () => {
  const root = path.resolve('skills-root');
  const inRoot = (...parts: string[]): string => path.join(root, ...parts);
  const shouldSkip = createWatchFilter({
    root,
    patterns: DEFAULT_PATTERNS,
    ignored: DEFAULT_IGNORED,
  });

  it('never skips the watched directory itself', () => {
    expect(shouldSkip(root)).toBe(false);
    expect(shouldSkip(root, DIRECTORY)).toBe(false);
  });

  it('keeps skill files at any depth', () => {
    expect(shouldSkip(inRoot('a.skill.md'), FILE)).toBe(false);
    expect(shouldSkip(inRoot('custom', 'a.ts'), FILE)).toBe(false);
    expect(shouldSkip(inRoot('built-in', 'deep', 'a.js'), FILE)).toBe(false);
  });

  it('skips files that match no pattern', () => {
    expect(shouldSkip(inRoot('notes.txt'), FILE)).toBe(true);
    expect(shouldSkip(inRoot('custom', 'README.md'), FILE)).toBe(true);
  });

  it('does not apply the patterns until a path is known to be a file', () => {
    // chokidar asks once without stats. Skipping here would stop it from
    // ever descending into subdirectories.
    expect(shouldSkip(inRoot('custom'))).toBe(false);
    expect(shouldSkip(inRoot('custom'), DIRECTORY)).toBe(false);
    expect(shouldSkip(inRoot('notes.txt'))).toBe(false);
  });

  it('skips ignored directories with or without stats', () => {
    expect(shouldSkip(inRoot('node_modules'))).toBe(true);
    expect(shouldSkip(inRoot('.disabled'), DIRECTORY)).toBe(true);
    expect(shouldSkip(inRoot('custom', 'dist'), DIRECTORY)).toBe(true);
    expect(shouldSkip(inRoot('.disabled', 'off.skill.md'), FILE)).toBe(true);
    expect(shouldSkip(inRoot('node_modules', 'pkg', 'index.js'), FILE)).toBe(true);
  });

  it('skips declaration files although they end in .ts', () => {
    expect(shouldSkip(inRoot('types.d.ts'), FILE)).toBe(true);
    expect(shouldSkip(inRoot('custom', 'types.d.ts'))).toBe(true);
  });

  it('accepts paths with either separator', () => {
    const forward = inRoot('custom', 'a.skill.md').replace(/\\/g, '/');

    expect(shouldSkip(forward, FILE)).toBe(false);
    expect(shouldSkip(`${root.replace(/\\/g, '/')}/.disabled/a.skill.md`, FILE)).toBe(true);
  });

  it('matches ignored globs that are absolute paths', () => {
    const drafts = inRoot('custom', 'drafts').replace(/\\/g, '/');
    const skipDrafts = createWatchFilter({
      root,
      patterns: DEFAULT_PATTERNS,
      ignored: [`${drafts}/**`],
    });

    expect(skipDrafts(inRoot('custom', 'drafts'))).toBe(true);
    expect(skipDrafts(inRoot('custom', 'drafts', 'a.skill.md'), FILE)).toBe(true);
    expect(skipDrafts(inRoot('custom', 'a.skill.md'), FILE)).toBe(false);
  });

  it('takes patterns relative to the root', () => {
    const onlyCustom = createWatchFilter({
      root,
      patterns: ['custom/**/*.skill.md'],
      ignored: [],
    });

    expect(onlyCustom(inRoot('custom', 'team', 'a.skill.md'), FILE)).toBe(false);
    expect(onlyCustom(inRoot('a.skill.md'), FILE)).toBe(true);
    expect(onlyCustom(inRoot('custom', 'a.ts'), FILE)).toBe(true);
  });
});
