import { readdir } from 'node:fs/promises';

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
