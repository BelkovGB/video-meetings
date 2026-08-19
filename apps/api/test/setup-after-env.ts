import { assertStorageDirectoriesAreEmpty } from './support/storage-leftovers';
import { storageDirectories } from './support/storage-roots';

// Registered before the spec file is evaluated, so this root-level hook runs
// after every describe-level `afterAll`. Checking per suite instead of only at
// the end of the run makes the guard independent of jest's suite ordering: a
// suite that leaves avatars behind is caught even when a later suite would have
// wiped the avatar root, and the failure names the suite that produced them.
afterAll(async () => {
  await assertStorageDirectoriesAreEmpty(
    storageDirectories,
    expect.getState().testPath ?? 'this suite',
  );
});
