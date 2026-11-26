/**
 * Tests for the skill watcher's path filter (src/skills/watch-filter.ts)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createWatchFilter,
  crossesSymlink,
  globToRegExp,
  isMarkdownSkillFile,
  PathKind,
} from '../src/skills/watch-filter';

const FILE: PathKind = { isFile: () => true };
const DIRECTORY: PathKind = { isFile: () => false };
const LINK: PathKind = { isFile: () => false, isSymbolicLink: () => true };
const REAL_FILE: PathKind = { isFile: () => true, isSymbolicLink: () => false };

/** See tryLink in skill-watcher.test.ts: false means Windows refused a file link. */
function tryLink(target: string, linkPath: string, kind: 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, linkPath, kind === 'dir' ? 'junction' : 'file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

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

  it('applies relative ignored globs below the root only', () => {
    for (const parent of ['dist', 'node_modules', '.disabled']) {
      const nestedRoot = path.resolve(parent, 'tenant', 'skills');
      const skip = createWatchFilter({
        root: nestedRoot,
        patterns: DEFAULT_PATTERNS,
        ignored: DEFAULT_IGNORED,
      });

      expect(skip(nestedRoot)).toBe(false);
      expect(skip(path.join(nestedRoot, 'sample.skill.md'))).toBe(false);
      expect(skip(path.join(nestedRoot, 'sample.skill.md'), FILE)).toBe(false);
      expect(skip(path.join(nestedRoot, 'custom'), DIRECTORY)).toBe(false);
      expect(skip(path.join(nestedRoot, 'custom', 'a.ts'), FILE)).toBe(false);
      expect(skip(path.join(nestedRoot, parent, 'a.skill.md'), FILE)).toBe(true);
    }
  });

  it('treats a symbolic link as a file: kept when its path matches a pattern', () => {
    // So the watcher hears about a skill file that was replaced by a link.
    // chokidar is told not to follow links, so keeping one walks nothing.
    expect(shouldSkip(inRoot('custom', 'linked.skill.md'), LINK)).toBe(false);
    expect(shouldSkip(inRoot('linked-dir'), LINK)).toBe(true);
    expect(shouldSkip(inRoot('.disabled', 'linked.skill.md'), LINK)).toBe(true);
    expect(shouldSkip(inRoot('custom', 'real.skill.md'), REAL_FILE)).toBe(false);
    expect(shouldSkip(root, LINK)).toBe(false);
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

describe('isMarkdownSkillFile', () => {
  it('is true for a file name that ends in .skill.md, with either separator', () => {
    expect(isMarkdownSkillFile('/skills/a.skill.md')).toBe(true);
    expect(isMarkdownSkillFile('C:\\skills\\custom\\a.skill.md')).toBe(true);
    expect(isMarkdownSkillFile('a.skill.md')).toBe(true);
  });

  it('is false for code files and for anything else', () => {
    const others = [
      'a.js',
      'a.ts',
      'a.skill.js',
      'a.skill.ts',
      'a.skill.md.js',
      'a.skill.md/b.js',
      'a.skill.md\\b.ts',
      'a.md',
      'a.skill.mdx',
      'a.SKILL.MD',
      'a.skill.md ',
    ];
    for (const other of others) {
      expect([other, isMarkdownSkillFile(other)]).toEqual([other, false]);
    }
  });
});

describe('crossesSymlink', () => {
  let tempRoot: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-watch-filter-'));
    root = path.join(tempRoot, 'skills');
    outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(path.join(root, 'custom'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'custom', 'real.skill.md'), 'x');
    fs.writeFileSync(path.join(outside, 'external.js'), 'x');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('is false for a real file below the root', () => {
    expect(crossesSymlink(root, path.join(root, 'custom', 'real.skill.md'))).toBe(false);
  });

  it('is true for a file inside a linked directory', () => {
    expect(tryLink(outside, path.join(root, 'linked'), 'dir')).toBe(true);

    expect(crossesSymlink(root, path.join(root, 'linked', 'external.js'))).toBe(true);
  });

  it('is true for a linked file', () => {
    const linkPath = path.join(root, 'custom', 'linked.js');
    if (!tryLink(path.join(outside, 'external.js'), linkPath, 'file')) {
      // Windows without the privilege to create file links: nothing to check.
      return;
    }

    expect(crossesSymlink(root, linkPath)).toBe(true);
  });

  it('is true below a root that is itself a link, and false below a link further up', () => {
    // The skill watcher refuses a linked skills directory at start(); a root
    // that has become a link since then must not be read through.
    const linkedRoot = path.join(tempRoot, 'skills-link');
    expect(tryLink(root, linkedRoot, 'dir')).toBe(true);
    expect(crossesSymlink(linkedRoot, path.join(linkedRoot, 'custom', 'real.skill.md'))).toBe(true);

    const linkedParent = path.join(tempRoot, 'parent-link');
    expect(tryLink(tempRoot, linkedParent, 'dir')).toBe(true);
    const rootBelowLink = path.join(linkedParent, 'skills');
    expect(crossesSymlink(rootBelowLink, path.join(rootBelowLink, 'custom', 'real.skill.md'))).toBe(false);
  });

  it('is true for a path outside the root, the root itself and a missing file', () => {
    expect(crossesSymlink(root, path.join(outside, 'external.js'))).toBe(true);
    expect(crossesSymlink(root, path.join(root, '..', 'outside', 'external.js'))).toBe(true);
    expect(crossesSymlink(root, root)).toBe(true);
    expect(crossesSymlink(root, path.join(root, 'custom', 'gone.skill.md'))).toBe(true);
  });

  it('does not mistake a name that starts with two dots for a parent path', () => {
    fs.writeFileSync(path.join(root, '..hidden.skill.md'), 'x');

    expect(crossesSymlink(root, path.join(root, '..hidden.skill.md'))).toBe(false);
  });
});
