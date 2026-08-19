import { Injectable, Logger } from '@nestjs/common';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const loadModule = createRequire(__filename);
const sharp = loadModule('sharp') as typeof import('sharp').default;

import { AvatarBytes } from './avatar-content';
import { LocalAvatarStorageService } from './local-avatar-storage.service';

/** Twice the 24 px a file row paints, so a dense display still looks sharp. */
const LIST_VARIANT_PIXELS = 96;
/** The size is part of the name: changing it derives afresh instead of serving the old size. */
const LIST_VARIANT_FILE = `list-${LIST_VARIANT_PIXELS}`;
/**
 * What a picture of `LIST_VARIANT_PIXELS` is worth on the wire. Fitting the box
 * is not enough to be cheap: validation only decodes to verify, so an avatar may
 * be small on screen and megabytes on disk — an animated WebP or APNG on a tiny
 * canvas, or a PNG or JPEG carrying large text, ICC or EXIF payloads. Above this
 * budget the picture is re-encoded even when it needs no resizing, which drops
 * text and EXIF outright, drops an oversized colour profile as well, and is
 * cheap at this size.
 */
const LIST_VARIANT_MAX_BYTES = 16 * 1024;
/**
 * How much colour profile a picture of this size is worth carrying. The profile
 * is kept so a row and the profile page do not render the same face in
 * different colours, but LUT-based and device-link profiles legitimately run to
 * hundreds of kilobytes and can be crafted up to `AVATAR_MAX_BYTES`:
 * re-embedding one would put back on the wire exactly what the variant removes,
 * to describe the colours of a 24 px picture.
 */
const LIST_VARIANT_MAX_ICC_BYTES = 4 * 1024;
/**
 * An empty variant records that the original is what a row should receive, so
 * it is served as it is rather than stored a second time. It is written for a
 * decision — the original fits the box and the budget, or re-encoding it pays
 * nothing — and never for a failure, which the next request retries.
 */
const NO_VARIANT = Buffer.alloc(0);

const variantFormats = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

type StoredAvatar = { storageKey: string; mimeType: string; sizeBytes: number };

/**
 * Serves the picture a list of rows needs instead of the stored original, which
 * may be `AVATAR_MAX_BYTES` (5 MiB) for a 24 px image. Avatar responses are
 * `private, no-store`, so a browser repeats the download on every view of the
 * list: the variant is what makes that repetition cheap.
 *
 * The variant is derived once and kept beside the original under the avatar's
 * storage key, so replacement, removal and storage reconciliation drop it with
 * the avatar they belong to and no request can ever read a variant of a
 * replaced picture.
 */
@Injectable()
export class AvatarListVariantService {
  private readonly logger = new Logger(AvatarListVariantService.name);
  /**
   * Derivations running right now, one per storage key. Deriving buffers and
   * decodes the whole original, so a burst of first views of one uploader must
   * share a single decode rather than each hold a copy: this route is
   * authenticated but its cost is otherwise unbounded by anything but arrival
   * rate.
   */
  private readonly running = new Map<string, Promise<Buffer | null>>();

  constructor(private readonly avatars: LocalAvatarStorageService) {}

  async open(stored: StoredAvatar): Promise<AvatarBytes> {
    const published = await this.openDerived(stored);
    if (published) {
      return published;
    }

    const derived = await this.deriveOnce(stored.storageKey, stored.mimeType);
    const stream = await this.openDerived(stored);
    if (stream) {
      return stream;
    }

    // The variant could not be stored — a concurrent replacement, a full disk.
    // The bytes in hand still answer this request; the next one derives again.
    return derived
      ? { mimeType: stored.mimeType, sizeBytes: derived.length, stream: Readable.from(derived) }
      : {
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          stream: await this.avatars.open(stored.storageKey),
        };
  }

  /**
   * Derives the variant ahead of the first read, from the bytes the upload path
   * already validated, so the read path stays a plain file open and the upload
   * neither reads the picture off disk a second time nor decodes what it is
   * holding. A failure is not the uploader's problem: the read path derives
   * again.
   */
  async prepare(storageKey: string, mimeType: string, content: Buffer): Promise<void> {
    try {
      await this.deriveOnce(storageKey, mimeType, content);
    } catch (error) {
      this.logger.warn(
        `Failed to derive the list variant of an avatar at upload: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Opens what was derived earlier, or `null` when nothing was — because it has
   * not been derived yet, or because the last attempt failed. An empty variant
   * is the recorded decision that the original is what a list should receive,
   * so it is served as it is rather than stored a second time.
   */
  private async openDerived(stored: StoredAvatar): Promise<AvatarBytes | null> {
    const variant = await this.avatars.openVariant(stored.storageKey, LIST_VARIANT_FILE);
    if (!variant) {
      return null;
    }
    if (variant.sizeBytes === 0) {
      variant.stream.destroy();
      return {
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        stream: await this.avatars.open(stored.storageKey),
      };
    }

    return { mimeType: stored.mimeType, sizeBytes: variant.sizeBytes, stream: variant.stream };
  }

  private async deriveOnce(
    storageKey: string,
    mimeType: string,
    content?: Buffer,
  ): Promise<Buffer | null> {
    const running = this.running.get(storageKey);
    if (running) {
      return running;
    }

    const derivation = this.deriveAndStore(storageKey, mimeType, content).finally(() => {
      this.running.delete(storageKey);
    });
    this.running.set(storageKey, derivation);
    return derivation;
  }

  private async deriveAndStore(
    storageKey: string,
    mimeType: string,
    content?: Buffer,
  ): Promise<Buffer | null> {
    const original = content ?? (await this.avatars.readContent(storageKey));
    let derived: Buffer | null;
    try {
      derived = await this.derive(original, mimeType);
    } catch (error) {
      // A decode that threw is a failure, not a decision, and it can be
      // transient: memory pressure, EMFILE, a libvips hiccup. Publishing the
      // marker for it would pin this avatar to full-size delivery on every view
      // of every file list for as long as it is the user's picture, so nothing is
      // recorded and the next request derives again.
      this.logger.warn(
        `Failed to derive the list variant of an avatar, serving the stored original: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }

    await this.avatars.saveVariant(storageKey, LIST_VARIANT_FILE, derived ?? NO_VARIANT);
    return derived;
  }

  /**
   * Returns the smaller picture, or `null` when the stored original is already
   * what a row should receive. The format stays the stored one, so the response
   * keeps its verified content type, and a small source colour profile is
   * carried over so a row and the profile page do not render the same face in
   * different colours; a profile too large to be worth its bytes here is
   * dropped, as text and EXIF payloads always are. An animated avatar loses its
   * frames here, which a 24 px row does not show anyway. A picture that cannot
   * be decoded throws, so the caller can tell a failure from a decision.
   */
  private async derive(original: Buffer, mimeType: string): Promise<Buffer | null> {
    const format = variantFormats[mimeType as keyof typeof variantFormats];
    if (!format) {
      return null;
    }

    const source = sharp(original, { failOn: 'error', limitInputPixels: 40_000_000 });
    const { width, height, icc } = await source.metadata();
    const fitsBox =
      width !== undefined &&
      height !== undefined &&
      width <= LIST_VARIANT_PIXELS &&
      height <= LIST_VARIANT_PIXELS;
    if (fitsBox && original.length <= LIST_VARIANT_MAX_BYTES) {
      return null;
    }

    // The profile is measured before the re-encode rather than the result
    // after it, so nothing that survives into the variant is unbounded: an
    // oversized profile is dropped, and what is left is a 96 px picture.
    const keepProfile = icc !== undefined && icc.length <= LIST_VARIANT_MAX_ICC_BYTES;
    const content = await this.encode(original, format, keepProfile);

    return content.length < original.length ? content : null;
  }

  private async encode(
    original: Buffer,
    format: (typeof variantFormats)[keyof typeof variantFormats],
    keepProfile: boolean,
  ): Promise<Buffer> {
    let resized = sharp(original, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .resize(LIST_VARIANT_PIXELS, LIST_VARIANT_PIXELS, {
        fit: 'cover',
        withoutEnlargement: true,
      });
    if (keepProfile) {
      resized = resized.keepIccProfile();
    }

    return format === 'png'
      ? resized.png({ compressionLevel: 9 }).toBuffer()
      : format === 'jpeg'
        ? resized.jpeg({ quality: 82 }).toBuffer()
        : resized.webp({ quality: 82 }).toBuffer();
  }
}
