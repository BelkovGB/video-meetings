import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// Leftover storage roots outlive a run: the e2e database is not reset, so the
// next application start finds a live user row for every stale avatar directory
// and pays one locked reconciliation transaction per directory. A suite that
// writes to a root must therefore remove it before and after itself, and this
// guard fails when a suite starts writing without adding that cleanup.
const testDirectory = __dirname;

type RootUsage = {
  root: 'uploadRoot' | 'avatarUploadRoot';
  writes: (source: string) => boolean;
};

const roots: RootUsage[] = [
  {
    root: 'uploadRoot',
    writes: (source) => /\.post\(`\/meetings\/\$\{[^}]+\}\/files`\)/.test(source),
  },
  {
    root: 'avatarUploadRoot',
    writes: (source) => source.includes('/users/me/avatar'),
  },
];

function removesRoot(source: string, root: string): boolean {
  const normalized = source.replace(/\s+/g, ' ');

  return normalized.split(`await rm(${root}, { recursive: true, force: true });`).length - 1 >= 2;
}

describe('e2e storage root cleanup', () => {
  it('removes every storage root that a suite writes to', async () => {
    const suites = (await readdir(testDirectory)).filter(
      // This guard only reads sources, so it names both roots without writing to either.
      (name) => name.endsWith('.e2e-spec.ts') && name !== basename(__filename),
    );
    expect(suites.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const suite of suites) {
      const source = await readFile(join(testDirectory, suite), 'utf8');
      for (const { root, writes } of roots) {
        if (writes(source) && !removesRoot(source, root)) {
          missing.push(`${suite} writes to ${root} without removing it twice`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
