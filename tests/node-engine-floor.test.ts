/**
 * The minimum Node version this package declares has to be one its native
 * sqlite dependency accepts. better-sqlite3 13 needs Node 22 or later, and
 * `engines.node` still said >=18 when that bump was first proposed.
 *
 * The lockfile, the README and the CI workflow each repeat the minimum, so
 * they are checked against `package.json` here as well.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

type Version = [number, number, number];

interface PackageManifest {
  engines?: { node?: string };
}

interface PackageLock {
  packages: Record<string, PackageManifest>;
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

/** Reads a range of the form ">=22", ">=22.12" or ">=22.12.0". Anything else throws. */
function parseFloor(range: string | undefined, owner: string): Version {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec((range ?? '').trim());
  if (!match) {
    throw new Error(
      `${owner} engines.node is "${range}", which is not a plain ">=x.y.z" minimum. ` +
        'Update tests/node-engine-floor.test.ts to read the new form.'
    );
  }
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function isAtLeast(version: Version, minimum: Version): boolean {
  for (let i = 0; i < version.length; i++) {
    if (version[i] !== minimum[i]) {
      return version[i] > minimum[i];
    }
  }
  return true;
}

/** [22, 0, 0] -> "22", [22, 12, 0] -> "22.12", [22, 12, 1] -> "22.12.1". */
function formatShort(version: Version): string {
  const parts: number[] = [...version];
  while (parts.length > 1 && parts[parts.length - 1] === 0) {
    parts.pop();
  }
  return parts.join('.');
}

describe('minimum Node version', () => {
  const declaredRange = readJson<PackageManifest>('package.json').engines?.node;
  const declared = parseFloor(declaredRange, 'package.json');

  it('is one that better-sqlite3 accepts', () => {
    const sqlite = readJson<PackageManifest>('node_modules/better-sqlite3/package.json');
    const required = parseFloor(sqlite.engines?.node, 'better-sqlite3');

    expect(isAtLeast(declared, required)).toBe(true);
  });

  it('is the same in the root entry of package-lock.json', () => {
    const lock = readJson<PackageLock>('package-lock.json');

    expect(lock.packages[''].engines?.node).toBe(declaredRange);
  });

  it('is the version the README states', () => {
    const readme = readText('README.md');
    const short = formatShort(declared);

    expect(readme).toContain(`badge/node-%3E%3D${short}-`);
    expect(readme).toContain(`| Node.js | >= ${short} |`);
  });

  it('has the same major version as the one CI runs the tests on', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const match = /node-version:\s*['"]?(\d+)/.exec(workflow);

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(declared[0]);
  });
});
