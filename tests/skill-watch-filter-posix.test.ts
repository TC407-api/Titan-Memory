/**
 * The skill watcher's path filter with POSIX paths, where a backslash is an
 * ordinary file name character and not a separator. The filter's `path` is
 * replaced by `path.posix`, so this runs the same on Windows.
 */

jest.mock('path', () => jest.requireActual('path').posix);

import { createWatchFilter, hasBackslashInName, PathKind } from '../src/skills/watch-filter';

const FILE: PathKind = { isFile: () => true };
const DIRECTORY: PathKind = { isFile: () => false };

describe('createWatchFilter with POSIX paths', () => {
  it('does not read a backslash in a file name as a directory separator', () => {
    const onlyTeam = createWatchFilter({
      root: '/skills',
      patterns: ['team/**/*.skill.md'],
      ignored: [],
    });

    expect(onlyTeam('/skills/team/daily.skill.md', FILE)).toBe(false);
    // A file in the skills directory itself, named "team\daily.skill.md".
    expect(onlyTeam('/skills/team\\daily.skill.md', FILE)).toBe(true);
  });

  it('skips every name below the root that has a backslash in it', () => {
    // chokidar turns a backslash into "/" before it asks the filter, so the
    // filter cannot know how such a name was spelled. It is never loaded.
    const skip = createWatchFilter({
      root: '/skills',
      patterns: ['**/*.skill.md'],
      ignored: ['**/.disabled/**'],
    });

    expect(skip('/skills/.disabled\\daily.skill.md', FILE)).toBe(true);
    expect(skip('/skills/a\\b.skill.md', FILE)).toBe(true);
    expect(skip('/skills/custom/a\\b.skill.md', FILE)).toBe(true);
    expect(skip('/skills/a\\b', DIRECTORY)).toBe(true);
    expect(skip('/skills/custom/a.skill.md', FILE)).toBe(false);
    expect(skip('/skills', DIRECTORY)).toBe(false);
  });

  it('finds a backslash anywhere in a path, so start() can refuse such a skills directory', () => {
    expect(hasBackslashInName('/tmp/team\\one')).toBe(true);
    expect(hasBackslashInName('/tmp\\x/skills')).toBe(true);
    expect(hasBackslashInName('/tmp/team/one')).toBe(false);
  });

  it('still accepts a glob written with backslashes', () => {
    const onlyTeam = createWatchFilter({
      root: '/skills',
      patterns: ['team\\**\\*.skill.md'],
      ignored: [],
    });

    expect(onlyTeam('/skills/team/daily.skill.md', FILE)).toBe(false);
    expect(onlyTeam('/skills/daily.skill.md', FILE)).toBe(true);
  });
});
