import { assertStorageDirectoriesAreEmpty } from './support/storage-leftovers';
import { storageDirectories } from './support/storage-roots';

// Registered before the spec file is evaluated, so this root-level hook runs
// after every describe-level `afterAll`. Checking per suite instead of only at
// the end of the run makes the guard independent of jest's suite ordering: a
// suite that leaves avatars behind is caught even when a later suite would have
// wiped the avatar root, and the failure names the suite that produced them.
//
// Both the read and the self-healing removal target process-wide shared paths,
// so this is only safe while suites are serialized. `--runInBand` in the npm
// script does not cover an ad hoc `jest --config ./test/jest-e2e.json <filter>`,
// which is why `maxWorkers: 1` lives in test/jest-e2e.json instead; the wiring
// is asserted in test/storage-root-cleanup.e2e-spec.ts.
afterAll(async () => {
  await assertStorageDirectoriesAreEmpty(
    storageDirectories,
    expect.getState().testPath ?? 'this suite',
  );
});
