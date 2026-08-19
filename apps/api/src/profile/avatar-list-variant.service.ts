import { Injectable, Logger } from '@nestjs/common';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const loadModule = createRequire(__filename);
const sharp = loadModule('sharp') as typeof import('sharp').default;

import { AvatarContent } from './avatar-content';
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
 * budget the picture is re-encoded even when it needs no resizing, which both
 * strips the payload and is cheap at this size.
 */
const LIST_VARIANT_MAX_BYTES = 16 * 1024;
/** An empty variant records "the original is already list-sized" without copying it. */
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

  async open(stored: StoredAvatar): Promise<AvatarContent> {
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
   * Derives the variant ahead of the first read. The upload path already holds
   * and decodes the picture once, so paying there keeps the read path a plain
   * file open. A failure is not the uploader's problem: the read path derives
   * again.
   */
  async prepare(storageKey: string, mimeType: string): Promise<void> {
    try {
      await this.deriveOnce(storageKey, mimeType);
    } catch (error) {
      this.logger.warn(
        `Failed to derive the list variant of an avatar at upload: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Opens what was derived earlier, or `null` when nothing was. An empty
   * variant is the recorded decision that the original is already list-sized,
   * so it is served as it is rather than stored a second time.
   */
  private async openDerived(stored: StoredAvatar): Promise<AvatarContent | null> {
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

  private async deriveOnce(storageKey: string, mimeType: string): Promise<Buffer | null> {
    const running = this.running.get(storageKey);
    if (running) {
      return running;
    }

    const derivation = this.deriveAndStore(storageKey, mimeType).finally(() => {
      this.running.delete(storageKey);
    });
    this.running.set(storageKey, derivation);
    return derivation;
  }

  private async deriveAndStore(storageKey: string, mimeType: string): Promise<Buffer | null> {
    const original = await this.avatars.readContent(storageKey);
    const derived = await this.derive(original, mimeType);
    await this.avatars.saveVariant(storageKey, LIST_VARIANT_FILE, derived ?? NO_VARIANT);
    return derived;
  }

  /**
   * Returns the smaller picture, or `null` when the stored original is already
   * what a row should receive, or when it cannot be re-encoded at all. The
   * format stays the stored one, so the response keeps its verified content
   * type, and the source colour profile is carried over so a row and the
   * profile page do not render the same face in different colours. An animated
   * avatar loses its frames here, which a 24 px row does not show anyway.
   */
  private async derive(original: Buffer, mimeType: string): Promise<Buffer | null> {
    const format = variantFormats[mimeType as keyof typeof variantFormats];
    if (!format) {
      return null;
    }

    try {
      const source = sharp(original, { failOn: 'error', limitInputPixels: 40_000_000 });
      const { width, height } = await source.metadata();
      const fitsBox =
        width !== undefined &&
        height !== undefined &&
        width <= LIST_VARIANT_PIXELS &&
        height <= LIST_VARIANT_PIXELS;
      if (fitsBox && original.length <= LIST_VARIANT_MAX_BYTES) {
        return null;
      }

      const resized = sharp(original, { failOn: 'error', limitInputPixels: 40_000_000 })
        .rotate()
        .resize(LIST_VARIANT_PIXELS, LIST_VARIANT_PIXELS, {
          fit: 'cover',
          withoutEnlargement: true,
        })
        .keepIccProfile();
      const content =
        format === 'png'
          ? await resized.png({ compressionLevel: 9 }).toBuffer()
          : format === 'jpeg'
            ? await resized.jpeg({ quality: 82 }).toBuffer()
            : await resized.webp({ quality: 82 }).toBuffer();

      return content.length < original.length ? content : null;
    } catch (error) {
      this.logger.warn(
        `Failed to derive the list variant of an avatar, serving the stored original: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }
  }
}
