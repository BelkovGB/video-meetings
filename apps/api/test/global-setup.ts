import { removeStorageRoots } from './support/storage-cleanup';
import { avatarUploadRoot, uploadRoot } from './support/storage-roots';

/**
 * Clears the shared storage roots once, before any suite boots.
 *
 * The per-suite guard (test/setup-after-env.ts) only observes a directory after
 * the suite that used it has already started its application, so on its own it
 * cannot spare a run the cost of inheriting leftovers: an interrupted run
 * leaves stale avatar directories behind, the e2e database is not reset, and
 * `reconcileUnreferencedAvatars` then opens one locked transaction per stale
 * directory on every `onModuleInit`. Clearing here makes that cost independent
 * of which suites jest schedules first, and of whether the filtered invocation
 * includes a suite that owns a root at all.
 */
export default async function globalSetup(): Promise<void> {
  await removeStorageRoots([uploadRoot, avatarUploadRoot]);
}
