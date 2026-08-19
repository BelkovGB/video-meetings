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
 * Every step runs even when an earlier one failed. The run is serialized (see
 * `maxWorkers` in test/jest-e2e.json), so one process is shared across all
 * suites: a skipped environment restore leaks into every later suite, and
 * skipped removals make each later application start pay a reconciliation
 * transaction per stale directory.
 *
 * A removal that rejects because the failed close left handles open under the
 * root must not be all the developer is shown, so a close failure is reported
 * in preference to it and both are reported when both fail.
 */
export async function teardownStorageSuite(options: {
  close: () => Promise<void>;
  storageRoots: string[];
  restoreEnvironment: () => void;
}): Promise<void> {
  let closeFailure: { reason: unknown } | undefined;
  let removalFailure: { reason: unknown } | undefined;

  try {
    await options.close();
  } catch (reason) {
    closeFailure = { reason };
  }

  try {
    await removeStorageRoots(options.storageRoots);
  } catch (reason) {
    removalFailure = { reason };
  } finally {
    options.restoreEnvironment();
  }

  if (closeFailure && removalFailure) {
    throw new AggregateError(
      [closeFailure.reason, removalFailure.reason],
      'The application failed to close and the storage roots could not be removed. ' +
        'The close failure is the likely cause: handles left open under a root are ' +
        'what makes its removal fail.',
    );
  }

  if (closeFailure) {
    throw closeFailure.reason;
  }

  if (removalFailure) {
    throw removalFailure.reason;
  }
}
