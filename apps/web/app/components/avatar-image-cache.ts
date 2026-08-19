'use client';

type AvatarImageEntry = {
  leases: number;
  controller: AbortController;
  objectUrl: string | null;
  /** Resolves to the object URL every holder of this key shares. */
  url: Promise<string>;
  teardown: ReturnType<typeof setTimeout> | null;
};

/**
 * One download and one decoded image per key, however many components ask for
 * it. A meeting file list names its uploader once per file, so without this an
 * uploader with twenty files costs twenty identical downloads and twenty object
 * URLs held until the page is left.
 */
const entries = new Map<string, AvatarImageEntry>();

export type AvatarImageLease = {
  url: Promise<string>;
  /** Frees the image once its last holder is gone; safe to call twice. */
  release: () => void;
};

export function acquireAvatarImage(
  key: string,
  loadBlob: (signal: AbortSignal) => Promise<Blob>,
): AvatarImageLease {
  const entry = entries.get(key) ?? createEntry(key, loadBlob);
  if (entry.teardown) {
    clearTimeout(entry.teardown);
    entry.teardown = null;
  }
  entry.leases += 1;

  let released = false;

  return {
    url: entry.url,
    release: () => {
      if (released) {
        return;
      }

      released = true;
      entry.leases -= 1;
      if (entry.leases > 0 || entry.teardown) {
        return;
      }

      // A tick of grace, because a remount releases before it acquires again:
      // React does exactly that in strict mode, and re-rendering a list can too.
      // Without it the shared download would restart on every such remount.
      entry.teardown = setTimeout(() => {
        if (entries.get(key) === entry) {
          entries.delete(key);
        }

        // Nobody is waiting for these bytes any more: stop a download the
        // viewer has navigated away from, and free the decoded image.
        entry.controller.abort();
        if (entry.objectUrl) {
          URL.revokeObjectURL(entry.objectUrl);
          entry.objectUrl = null;
        }
      }, 0);
    },
  };
}

/**
 * Drops an image the browser could not decode, so its bytes are freed at once
 * and the next component asking for this key downloads it again instead of
 * inheriting the broken one. Every holder of the key falls back on its own,
 * since a picture that failed to decode fails for all of them.
 */
export function discardAvatarImage(key: string) {
  const entry = entries.get(key);
  if (!entry) {
    return;
  }

  entries.delete(key);
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = null;
  }
}

function createEntry(key: string, loadBlob: (signal: AbortSignal) => Promise<Blob>) {
  const controller = new AbortController();
  const entry: AvatarImageEntry = {
    leases: 0,
    controller,
    objectUrl: null,
    teardown: null,
    // The callbacks run long after this object exists, so they may name it.
    url: loadBlob(controller.signal).then(
      (blob) => {
        const objectUrl = URL.createObjectURL(blob);
        if (entries.get(key) !== entry) {
          // The last holder left while the download was finishing.
          URL.revokeObjectURL(objectUrl);
          throw new Error('Avatar no longer needed');
        }

        entry.objectUrl = objectUrl;
        return objectUrl;
      },
      (error: unknown) => {
        // A failure is not cached: the next holder of this key retries.
        if (entries.get(key) === entry) {
          entries.delete(key);
        }

        throw error;
      },
    ),
  };

  // Every holder attaches its own handler; this one keeps a rejection reported
  // to nobody from surfacing as an unhandled one.
  entry.url.catch(() => undefined);
  entries.set(key, entry);

  return entry;
}
