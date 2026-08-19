'use client';

/**
 * One route the bytes can come from. Several holders of a key usually name the
 * same picture through different routes — one meeting file each — so a route
 * that is itself gone says nothing about the picture, and the entry falls
 * through to the next one instead of blanking every holder. `id` is the route
 * itself, so a route already tried is not tried again.
 */
export type AvatarImageSource = {
  id: string;
  load: (signal: AbortSignal) => Promise<Blob>;
};

/**
 * The one failure that is worth another route: this route is gone while the
 * picture may still be readable through a different holder's route — the
 * meeting file behind one row was deleted, say. A loader must not throw it for
 * a failure that every route of the key would repeat (an expired token, a 5xx,
 * a lost network, an avatar the owner removed): the holders of a key are the
 * rows of one uploader, so falling through on those would cost one request per
 * row, which is the duplication this cache exists to remove.
 */
export class AvatarSourceGoneError extends Error {
  constructor(message = 'Avatar route is gone') {
    super(message);
    this.name = 'AvatarSourceGoneError';
  }
}

/**
 * How many routes one key may read before it gives up. A stale row is the case
 * this covers, and one alternate answers it; the cap is what keeps a meeting
 * whose whole list went stale at two requests instead of one per row, whatever
 * the loader reports.
 */
const maxSourceReads = 2;

type AvatarImageEntry = {
  leases: number;
  controller: AbortController;
  objectUrl: string | null;
  /** Resolves to the object URL every holder of this key shares. */
  url: Promise<string>;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
  /** Routes offered by holders and not read yet, in the order they arrived. */
  untried: AvatarImageSource[];
  triedIds: Set<string>;
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

export function acquireAvatarImage(key: string, source: AvatarImageSource): AvatarImageLease {
  const joined = entries.get(key);
  const entry = joined ?? createEntry(key, source);
  if (joined) {
    offerSource(joined, source);
  }

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
 *
 * @param objectUrl the image that failed. A component can report a failure long
 *   after its entry was dropped and a healthy one took the key, so the URL says
 *   which entry this is about and keeps the replacement from being revoked out
 *   from under the rows now showing it.
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
}

function createEntry(key: string, source: AvatarImageSource) {
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
    untried: [source],
    triedIds: new Set(),
  };

  // Every holder attaches its own handler; this one keeps a rejection reported
  // to nobody from surfacing as an unhandled one.
  entry.url.catch(() => undefined);
  entries.set(key, entry);
  readNextSource(key, entry);

  return entry;
}

function offerSource(entry: AvatarImageEntry, source: AvatarImageSource) {
  if (entry.objectUrl) {
    // The picture is already here; a spare route would only be kept alive for
    // nothing, and the whole entry is dropped if this image ever fails.
    return;
  }

  if (entry.triedIds.has(source.id) || entry.untried.some((known) => known.id === source.id)) {
    return;
  }

  entry.untried.push(source);
}

function readNextSource(key: string, entry: AvatarImageEntry) {
  const source = entry.untried.shift();
  if (!source) {
    return;
  }

  entry.triedIds.add(source.id);
  void source.load(entry.controller.signal).then(
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

      if (
        error instanceof AvatarSourceGoneError &&
        entry.untried.length > 0 &&
        entry.triedIds.size < maxSourceReads &&
        !entry.controller.signal.aborted
      ) {
        // This holder's route is gone — a file deleted out from under its row,
        // say — while the others still stream the same picture. Read one of
        // theirs before giving up, so a single stale row cannot blank every row
        // of the same uploader. Any other failure ends the read here: it would
        // answer the same on every route, and trying them would turn one
        // download per uploader back into one per row.
        readNextSource(key, entry);
        return;
      }

      // A failure is not cached: the next holder of this key retries.
      entries.delete(key);
      entry.reject(error);
    },
  );
}
