import { findStorageLeftovers } from './support/storage-leftovers';
import { storageDirectories } from './support/storage-roots';

/**
 * Fails the run when a suite left content in a shared storage directory.
 *
 * `--runInBand` keeps suites from racing over these directories, so anything
 * still here once the last suite finished is a missing cleanup that the next
 * run on this machine would inherit.
 */
export default async function assertStorageDirectoriesAreEmpty(): Promise<void> {
  const leftovers = await findStorageLeftovers(storageDirectories);

  if (leftovers.length > 0) {
    throw new Error(
      `E2E suites left content in shared storage directories:\n${leftovers.join('\n')}\n` +
        'Remove the storage root the suite writes to in its beforeAll and afterAll.',
    );
  }
}
