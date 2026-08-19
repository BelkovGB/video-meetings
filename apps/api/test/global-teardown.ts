import { assertStorageDirectoriesAreEmpty } from './support/storage-leftovers';
import { storageDirectories } from './support/storage-roots';

/**
 * Run-wide backstop for missing storage cleanup.
 *
 * test/setup-after-env.ts already asserts the same property after every suite,
 * which is what attributes leftovers to the suite that produced them. This hook
 * catches whatever escapes it — content written after a suite's own `afterAll`,
 * or by a run whose last suite crashed before its hooks completed.
 */
export default async function globalTeardown(): Promise<void> {
  await assertStorageDirectoriesAreEmpty(storageDirectories, 'the run');
}
