/**
 * The skill watcher's path filter with POSIX paths, where a backslash is an
 * ordinary file name character and not a separator. The filter's `path` is
 * replaced by `path.posix`, so this runs the same on Windows.
 */

jest.mock('path', () => jest.requireActual('path').posix);

import { createWatchFilter, PathKind } from '../src/skills/watch-filter';

const FILE: PathKind = { isFile: () => true };

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
