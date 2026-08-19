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
 *
 * That is an optimisation, so a removal that fails may not abort the run.
 * `rm` with `force: true` swallows only ENOENT and defaults to `maxRetries: 0`
 * (see support/storage-cleanup.ts), so on Windows a handle held by an indexer,
 * an antivirus scan or a crashed earlier run is enough to reject — and a
 * rejection out of `globalSetup` ends the run before a single suite is
 * scheduled, with an error naming neither storage cleanup nor a way forward.
 * The cost of tolerating it is bounded and self-healing: the roots that were
 * removed stay removed, and the first suite to observe what survived clears it
 * through the per-suite guard.
 */
export default async function globalSetup(): Promise<void> {
  const roots = [uploadRoot, avatarUploadRoot];

  await removeStorageRoots(roots).catch((reason: unknown) => {
    console.warn(
      `Could not clear the e2e storage roots before the run:\n${roots.join('\n')}\n` +
        `Reason: ${reason instanceof Error ? reason.message : String(reason)}\n` +
        'The run continues: whatever survived is cleared by the per-suite guard ' +
        '(test/setup-after-env.ts) after the first suite that observes it, at the ' +
        'cost of one reconciliation transaction per stale directory until then.',
    );
  });
}
