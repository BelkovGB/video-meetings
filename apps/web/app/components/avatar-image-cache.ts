'use client';

/** Reads the bytes of one avatar. Every holder of a key offers the same one. */
export type AvatarImageLoad = (signal: AbortSignal) => Promise<Blob>;

/**
 * How many pictures one key may put in front of the viewer before it gives up.
 * A body that arrived truncated fails to decode for reasons a fresh download
 * can fix, so one replacement is worth reading; a picture that fails again is
 * given up on for the whole key, so every row of that uploader ends on the same
 * fallback instead of the row that happened to report the failure.
 */
const maxDecodeAttempts = 2;

type AvatarImageEntry = {
  leases: number;
  controller: AbortController;
  objectUrl: string | null;
  /** Resolves to the object URL every holder of this key shares. */
  url: Promise<string>;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
  teardown: ReturnType<typeof setTimeout> | null;
};

/**
 * One download and one decoded image per key, however many components ask for
 * it. A meeting file list names its uploader once per file, so without this an
 * uploader with twenty files costs twenty identical downloads and twenty object
 * URLs held until the page is left.
 */
const entries = new Map<string, AvatarImageEntry>();

/**
 * What a key learned from the images it already handed out. It outlives the
 * entry on purpose: a discarded image would otherwise be downloaded again by
 * the next row to mount — an in-page upload inserts one at the top of the list
 * — and that row would show a picture its neighbours had already dropped.
 */
type AvatarDecodeState = {
  /** Images handed out for this key, including the one that failed. */
  attempt: number;
  listeners: Set<() => void>;
};

const decodes = new Map<string, AvatarDecodeState>();

/**
 * Which image of this key its holders are on. Folded into a holder's effect so
 * a discard re-runs it: the holders that did not report the failure re-acquire
 * together with the one that did, instead of keeping a fallback the key has
 * already moved past.
 */
export function readAvatarImageAttempt(key: string): number {
  return decodes.get(key)?.attempt ?? 0;
}

/** Calls `listener` whenever {@link readAvatarImageAttempt} changes for `key`. */
export function subscribeToAvatarImageAttempt(key: string, listener: () => void): () => void {
  const state = decodeStateOf(key);
  state.listeners.add(listener);

  return () => {
    state.listeners.delete(listener);
    if (state.listeners.size === 0 && state.attempt === 0 && decodes.get(key) === state) {
      // Nothing left to remember about a key that never failed.
      decodes.delete(key);
    }
  };
}

function decodeStateOf(key: string): AvatarDecodeState {
  const known = decodes.get(key);
  if (known) {
    return known;
  }

  const state: AvatarDecodeState = { attempt: 0, listeners: new Set() };
  decodes.set(key, state);

  return state;
}

export type AvatarImageLease = {
  url: Promise<string>;
  /** Frees the image once its last holder is gone; safe to call twice. */
  release: () => void;
};

export function acquireAvatarImage(key: string, load: AvatarImageLoad): AvatarImageLease {
  if (readAvatarImageAttempt(key) >= maxDecodeAttempts) {
    // This key already spent its attempts on images the browser refused, so a
    // row mounted afterwards gets the same refusal its neighbours are showing
    // rather than a download of its own.
    const url = Promise.reject(new Error('Avatar image cannot be decoded'));
    url.catch(() => undefined);

    return { url, release: () => undefined };
  }

  const entry = entries.get(key) ?? createEntry(key, load);

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
 * Drops an image the browser could not decode, so its bytes are freed at once,
 * and moves the key to its next attempt. A picture that failed to decode fails
 * for every holder of the key, so all of them are told: they re-acquire
 * together, and read one replacement between them rather than one per row.
 * Once {@link maxDecodeAttempts} images have been refused the key stops
 * offering any, including to rows mounted later, so one uploader is never half
 * avatar and half initial in the same list.
 *
 * @param objectUrl the image that failed. A component can report a failure long
 *   after its entry was dropped and a healthy one took the key, so the URL says
 *   which entry this is about and keeps the replacement from being revoked out
 *   from under the rows now showing it, or counted as a further attempt.
 */
export function discardAvatarImage(key: string, objectUrl: string) {
  const entry = entries.get(key);
  if (!entry || entry.objectUrl !== objectUrl) {
    return;
  }

  entries.delete(key);
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = null;
  }

  const state = decodeStateOf(key);
  state.attempt += 1;
  // A listener may unsubscribe while being told, so the set is read as it is now.
  for (const listener of [...state.listeners]) {
    listener();
  }
}

function createEntry(key: string, load: AvatarImageLoad) {
  const controller = new AbortController();
  let resolve!: (url: string) => void;
  let reject!: (error: unknown) => void;
  const url = new Promise<string>((resolveUrl, rejectUrl) => {
    resolve = resolveUrl;
    reject = rejectUrl;
  });

  const entry: AvatarImageEntry = {
    leases: 0,
    controller,
    objectUrl: null,
    teardown: null,
    url,
    resolve,
    reject,
  };

  // Every holder attaches its own handler; this one keeps a rejection reported
  // to nobody from surfacing as an unhandled one.
  entry.url.catch(() => undefined);
  entries.set(key, entry);
  readSource(key, entry, load);

  return entry;
}

function readSource(key: string, entry: AvatarImageEntry, load: AvatarImageLoad) {
  void load(entry.controller.signal).then(
    (blob) => {
      const objectUrl = URL.createObjectURL(blob);
      if (entries.get(key) !== entry) {
        // The last holder left while the download was finishing.
        URL.revokeObjectURL(objectUrl);
        entry.reject(new Error('Avatar no longer needed'));
        return;
      }

      entry.objectUrl = objectUrl;
      entry.resolve(objectUrl);
    },
    (error: unknown) => {
      if (entries.get(key) !== entry) {
        entry.reject(error);
        return;
      }

      // A failure is not cached: the next holder of this key retries.
      entries.delete(key);
      entry.reject(error);
    },
  );
}
