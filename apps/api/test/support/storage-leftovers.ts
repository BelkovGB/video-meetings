import { readdir } from 'node:fs/promises';

import { removeStorageRoots } from './storage-cleanup';

/**
 * Lists everything a run left inside the shared e2e storage directories.
 *
 * Leftovers outlive a run: the e2e database is not reset, so the next
 * application start finds a live `user` row for every stale avatar directory
 * and pays one locked reconciliation transaction per directory. Reporting the
 * actual directory contents covers every write path regardless of how a suite
 * spells its cleanup, which grepping the sources for `rm` calls cannot do.
 */
export async function findStorageLeftovers(directories: string[]): Promise<string[]> {
  const leftovers: string[] = [];

  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory, { recursive: true });
    } catch (error) {
      // A suite that removed the whole root left nothing behind.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    for (const entry of entries.sort()) {
      leftovers.push(`${directory}: ${entry}`);
    }
  }

  return leftovers;
}

/**
 * Fails when content is left in a shared storage directory, after clearing it.
 *
 * The directories are scratch space that no run may inherit, so the leftovers
 * are removed before the failure is raised: an interrupted run would otherwise
 * make every later filtered invocation fail on content it never produced, and
 * only a run including the suite that clears the root would recover.
 */
export async function assertStorageDirectoriesAreEmpty(
  directories: string[],
  source: string,
): Promise<void> {
  const leftovers = await findStorageLeftovers(directories);

  if (leftovers.length === 0) {
    return;
  }

  // A removal failure must not hide the leftovers it was reacting to.
  await removeStorageRoots(directories).catch(() => undefined);

  throw new Error(
    `E2E storage directories still held content after ${source}:\n${leftovers.join('\n')}\n` +
      'Remove the storage roots the suite writes to in its beforeAll and afterAll. ' +
      'The listed content has been cleared; if the suite named above never writes ' +
      'these paths, it is stale content from an earlier interrupted run and this ' +
      'failure will not repeat.',
  );
}
