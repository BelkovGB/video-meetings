import { Injectable } from '@nestjs/common';
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

const variantFormats = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

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
  constructor(private readonly avatars: LocalAvatarStorageService) {}

  async open(storageKey: string, mimeType: string): Promise<AvatarContent> {
    const stored = await this.avatars.openVariant(storageKey, LIST_VARIANT_FILE);
    if (stored) {
      return { mimeType, sizeBytes: stored.sizeBytes, stream: stored.stream };
    }

    const original = await this.avatars.readContent(storageKey);
    const derived = await this.derive(original, mimeType);
    // What is stored is what this route serves, so an avatar that needs no
    // resizing is stored as its own variant and the next request costs one file
    // open rather than another decode.
    const content = derived ?? original;
    await this.avatars.saveVariant(storageKey, LIST_VARIANT_FILE, content);

    const stream = await this.avatars.openVariant(storageKey, LIST_VARIANT_FILE);
    if (stream) {
      return { mimeType, sizeBytes: stream.sizeBytes, stream: stream.stream };
    }

    // The variant could not be stored — a concurrent replacement, a full disk.
    // The bytes in hand still answer this request; the next one derives again.
    return {
      mimeType,
      sizeBytes: content.length,
      stream: Readable.from(content),
    };
  }

  /**
   * Returns the smaller picture, or `null` when resizing fails or does not pay.
   * An avatar that already fits the variant box is kept byte for byte: re-encoding
   * it would change what every viewer receives to save a few bytes. The format
   * stays the stored one, so the response keeps its verified content type. An
   * animated avatar loses its frames here, which a 24 px row does not show anyway.
   */
  private async derive(original: Buffer, mimeType: string): Promise<Buffer | null> {
    const format = variantFormats[mimeType as keyof typeof variantFormats];
    if (!format) {
      return null;
    }

    try {
      const source = sharp(original, { failOn: 'error', limitInputPixels: 40_000_000 });
      const { width, height } = await source.metadata();
      if ((width ?? 0) <= LIST_VARIANT_PIXELS && (height ?? 0) <= LIST_VARIANT_PIXELS) {
        return null;
      }

      const resized = sharp(original, { failOn: 'error', limitInputPixels: 40_000_000 })
        .rotate()
        .resize(LIST_VARIANT_PIXELS, LIST_VARIANT_PIXELS, {
          fit: 'cover',
          withoutEnlargement: true,
        });
      const content =
        format === 'png'
          ? await resized.png({ compressionLevel: 9 }).toBuffer()
          : format === 'jpeg'
            ? await resized.jpeg({ quality: 82 }).toBuffer()
            : await resized.webp({ quality: 82 }).toBuffer();

      return content.length < original.length ? content : null;
    } catch {
      return null;
    }
  }
}
