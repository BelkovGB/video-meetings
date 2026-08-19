import { rm } from 'node:fs/promises';

/**
 * Removes every storage root, attempting all of them before failing.
 *
 * `fs.promises.rm` with `force: true` only swallows ENOENT and defaults to
 * `maxRetries: 0`, so an EBUSY/EPERM on one root — most likely on Windows right
 * after a failed `app.close()` left handles open — must not keep the other
 * roots from being cleared.
 */
export async function removeStorageRoots(roots: string[]): Promise<void> {
  const results = await Promise.allSettled(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );

  const failure = results.find((result) => result.status === 'rejected');
  if (failure) {
    throw (failure as PromiseRejectedResult).reason;
  }
}

/**
 * Tears an e2e suite down: closes the application, clears the storage roots it
 * wrote to, then restores the process environment.
 *
 * Every step runs even when an earlier one failed. `--runInBand` shares one
 * process across all suites, so a skipped environment restore leaks into every
 * later suite, and skipped removals make each later application start pay a
 * reconciliation transaction per stale directory.
 */
export async function teardownStorageSuite(options: {
  close: () => Promise<void>;
  storageRoots: string[];
  restoreEnvironment: () => void;
}): Promise<void> {
  try {
    await options.close();
  } finally {
    try {
      await removeStorageRoots(options.storageRoots);
    } finally {
      options.restoreEnvironment();
    }
  }
}
