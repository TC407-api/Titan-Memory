/**
 * The Node versions this package declares in `engines.node` have to be ones
 * its native sqlite dependency really runs on.
 *
 * better-sqlite3 13 declares `engines.node` ">=22", but its prebuilt binding
 * is compiled for Node-API 10, which Node only has from 22.14.0 on the 22
 * line and from 23.6.0 on the 23 line. On an older Node the package installs
 * and loads, and the process then crashes when a database is opened. So the
 * declared range is checked against the Node-API version of the binding, not
 * only against the dependency's own `engines` entry. The declared range is
 * also checked against the minimum chokidar declares, which is higher.
 *
 * The lockfile, the README and the CI workflow each repeat the minimum, so
 * they are checked against `package.json` here as well.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

type Version = [number, number, number];

interface Alternative {
  operator: '^' | '>=';
  floor: Version;
}

interface PackageManifest {
  engines?: { node?: string };
}

interface PackageLock {
  packages: Record<string, PackageManifest>;
}

/**
 * First Node release on each release line that has a given Node-API version.
 * A line that is not listed has it only if it is newer than every line listed.
 * Source: https://nodejs.org/api/n-api.html#node-api-version-matrix
 */
const NODE_API_FIRST_RELEASES: Record<number, Version[]> = {
  10: [
    [22, 14, 0],
    [23, 6, 0],
  ],
};

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

/**
 * Reads a range made of "^x.y.z" and ">=x.y.z" alternatives joined by "||".
 * Any other form throws, so that a new form is looked at instead of guessed.
 */
function parseRange(range: string | undefined, owner: string): Alternative[] {
  return (range ?? '').split('||').map((part) => {
    const match = /^(\^|>=)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part.trim());
    if (!match || (match[1] === '^' && match[2] === '0')) {
      throw new Error(
        `${owner} engines.node is "${range}". Only "^x.y.z" and ">=x.y.z" joined by "||" ` +
          'are understood. Update tests/node-engine-floor.test.ts to read the new form.'
      );
    }
    const floor: Version = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
    return { operator: match[1] as Alternative['operator'], floor };
  });
}

function isAtLeast(version: Version, minimum: Version): boolean {
  for (let i = 0; i < version.length; i++) {
    if (version[i] !== minimum[i]) {
      return version[i] > minimum[i];
    }
  }
  return true;
}

function admits(alternatives: Alternative[], version: Version): boolean {
  return alternatives.some(
    ({ operator, floor }) =>
      isAtLeast(version, floor) && (operator === '>=' || version[0] === floor[0])
  );
}

function findLowestFloor(alternatives: Alternative[]): Version {
  return alternatives
    .map((alternative) => alternative.floor)
    .reduce((lowest, floor) => (isAtLeast(floor, lowest) ? lowest : floor));
}

/** The highest version below the given one, with "any number" as the largest safe integer. */
function findVersionJustBelow([major, minor, patch]: Version): Version {
  const any = Number.MAX_SAFE_INTEGER;
  if (patch > 0) {
    return [major, minor, patch - 1];
  }
  return minor > 0 ? [major, minor - 1, any] : [major - 1, any, any];
}

function hasNodeApi(version: Version, firstReleases: Version[]): boolean {
  const sameLine = firstReleases.find((release) => release[0] === version[0]);
  if (sameLine) {
    return isAtLeast(version, sameLine);
  }
  return firstReleases.every((release) => version[0] > release[0]);
}

function readBindingFirstReleases(): Version[] {
  const gyp = readText('node_modules/better-sqlite3/binding.gyp');
  const nodeApiVersion = Number(/NAPI_VERSION=(\d+)/.exec(gyp)?.[1]);
  const firstReleases = NODE_API_FIRST_RELEASES[nodeApiVersion];
  if (!firstReleases) {
    throw new Error(
      `better-sqlite3 is built for Node-API ${nodeApiVersion}, which is not in ` +
        'NODE_API_FIRST_RELEASES. Add its first Node releases from the Node-API version matrix.'
    );
  }
  return firstReleases;
}

/** [22, 0, 0] -> "22", [22, 14, 0] -> "22.14", [22, 14, 1] -> "22.14.1". */
function formatShort(version: Version): string {
  const parts: number[] = [...version];
  while (parts.length > 1 && parts[parts.length - 1] === 0) {
    parts.pop();
  }
  return parts.join('.');
}

describe('declared Node versions (engines.node)', () => {
  const declaredRange = readJson<PackageManifest>('package.json').engines?.node;
  const declared = parseRange(declaredRange, 'package.json');
  const lowest = findLowestFloor(declared);

  it('start at or above the minimum better-sqlite3 declares', () => {
    const sqlite = readJson<PackageManifest>('node_modules/better-sqlite3/package.json');
    const required = findLowestFloor(parseRange(sqlite.engines?.node, 'better-sqlite3'));

    for (const { floor } of declared) {
      expect({ floor, allowed: isAtLeast(floor, required) }).toEqual({ floor, allowed: true });
    }
  });

  it('start at or above the minimum chokidar declares', () => {
    // chokidar 6 declares ">= 22.22". The skill watcher loads it with require().
    const chokidar = readJson<PackageManifest>('node_modules/chokidar/package.json');
    const required = findLowestFloor(parseRange(chokidar.engines?.node, 'chokidar'));

    for (const { floor } of declared) {
      expect({ floor, allowed: isAtLeast(floor, required) }).toEqual({ floor, allowed: true });
    }
  });

  it('start at a release that has the Node-API version of the better-sqlite3 binding', () => {
    const firstReleases = readBindingFirstReleases();

    for (const { floor } of declared) {
      expect({ floor, hasNodeApi: hasNodeApi(floor, firstReleases) }).toEqual({
        floor,
        hasNodeApi: true,
      });
    }
  });

  it('leave out every release from before that Node-API version', () => {
    const firstReleases = readBindingFirstReleases();
    const tooOld = firstReleases
      .map(findVersionJustBelow)
      .filter((version) => !hasNodeApi(version, firstReleases));

    expect(tooOld.length).toBeGreaterThan(0);
    for (const version of tooOld) {
      expect({ version, admitted: admits(declared, version) }).toEqual({
        version,
        admitted: false,
      });
    }
  });

  it('are the same in the root entry of package-lock.json', () => {
    const lock = readJson<PackageLock>('package-lock.json');

    expect(lock.packages[''].engines?.node).toBe(declaredRange);
  });

  it('are the ones the README states', () => {
    const readme = readText('README.md');
    const statsRow = readme.split('\n').find((line) => line.startsWith('| Node.js |')) ?? '';

    expect(readme).toContain(`badge/node-%3E%3D${formatShort(lowest)}-`);
    for (const { floor } of declared) {
      expect(statsRow).toContain(`>= ${formatShort(floor)}`);
    }
  });

  it('have their exact minimum in the CI test matrix', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const matrix = /node-version:\s*\[([^\]]*)\]/.exec(workflow)?.[1] ?? '';
    const versions = matrix.split(',').map((entry) => entry.trim().replace(/['"]/g, ''));

    expect(versions).toContain(lowest.join('.'));
  });
});
