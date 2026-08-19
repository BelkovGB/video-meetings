import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { deflateSync } from 'node:zlib';

const sharp = createRequire(__filename)('sharp') as typeof import('sharp').default;

import { AvatarListVariantService } from '../src/profile/avatar-list-variant.service';
import { avatarConfig } from '../src/profile/avatar.config';
import { LocalAvatarStorageService } from '../src/profile/local-avatar-storage.service';

const VARIANT_FILE = 'list-96';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

const crcTable = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A valid PNG carrying a large `tEXt` chunk. Avatar validation only decodes to
 * verify, so this is what an avatar that is tiny on screen and megabytes on the
 * wire looks like — the case the list variant exists to stop.
 */
function withTextChunk(png: Buffer, payloadBytes: number): Buffer {
  const payload = Buffer.concat([
    Buffer.from('Comment\0', 'latin1'),
    Buffer.alloc(payloadBytes, 0x41),
  ]);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payload.length)), 8 + payload.length);

  // The IEND chunk is the trailing 12 bytes; ancillary chunks precede it.
  const end = png.length - 12;
  return Buffer.concat([png.subarray(0, end), chunk, png.subarray(end)]);
}

/**
 * A valid PNG whose `iCCP` chunk holds a real colour profile padded with
 * incompressible bytes, the way a LUT-based or device-link profile is
 * legitimately hundreds of kilobytes. Validation accepts it untouched, so it is
 * the payload that survives a resize when the profile is carried over.
 */
async function withIccProfile(png: Buffer, paddingBytes: number): Promise<Buffer> {
  const source = await sharp(png).withMetadata({ icc: 'p3' }).png().toBuffer();
  const profile = Buffer.concat([
    (await sharp(source).metadata()).icc ?? Buffer.alloc(0),
    randomBytes(paddingBytes),
  ]);
  profile.writeUInt32BE(profile.length, 0);

  const payload = Buffer.concat([
    Buffer.from('c', 'latin1'),
    Buffer.from([0, 0]),
    deflateSync(profile),
  ]);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write('iCCP', 4, 'latin1');
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payload.length)), 8 + payload.length);

  // `iCCP` must precede the image data, so it goes straight after the 25-byte
  // IHDR chunk that follows the 8-byte signature.
  const at = 8 + 25;
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)]);
}

async function createPng(size: number, tone: number): Promise<Buffer> {
  const pixels = Buffer.alloc(size * size * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    pixels[index] = tone;
    pixels[index + 1] = (index / 3) % 2 === 0 ? 40 : 200;
    pixels[index + 2] = 60;
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

describe('AvatarListVariantService', () => {
  const storage = new LocalAvatarStorageService();
  const variants = new AvatarListVariantService(storage);
  const storageKeys: string[] = [];

  beforeAll(async () => {
    await storage.onModuleInit();
  });

  afterAll(async () => {
    await Promise.all(storageKeys.map(async (key) => storage.discard(key)));
  });

  async function store(content: Buffer): Promise<string> {
    const storageKey = `variant-${randomUUID()}`;
    storageKeys.push(storageKey);
    const tempPath = join(avatarConfig.tempDirectory, `${storageKey}.part`);
    await writeFile(tempPath, content);
    await storage.finalize(tempPath, storageKey);
    return storageKey;
  }

  function avatar(storageKey: string, sizeBytes: number) {
    return { storageKey, mimeType: 'image/png', sizeBytes };
  }

  it('shrinks an avatar that is larger than a list row needs', async () => {
    const original = await createPng(256, 20);
    const storageKey = await store(original);

    const served = await collect((await variants.open(avatar(storageKey, original.length))).stream);

    expect(served.length).toBeLessThan(original.length);
    const metadata = await sharp(served).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(96);
  });

  it('re-encodes an avatar that fits the box but is heavy on the wire', async () => {
    // 64 px on both sides, so the dimension guard alone would serve it whole,
    // and 64 KiB of ancillary payload that no viewer ever sees.
    const original = withTextChunk(await createPng(64, 20), 64 * 1024);
    const storageKey = await store(original);

    const content = await variants.open(avatar(storageKey, original.length));
    const served = await collect(content.stream);

    expect(served.length).toBeLessThan(original.length / 4);
    expect(content.sizeBytes).toBe(served.length);
    const metadata = await sharp(served).metadata();
    expect(metadata.width).toBe(64);
  });

  it('serves an already small avatar untouched without storing a second copy of it', async () => {
    const original = await createPng(48, 20);
    const storageKey = await store(original);

    const content = await variants.open(avatar(storageKey, original.length));

    expect(await collect(content.stream)).toEqual(original);
    expect(content.sizeBytes).toBe(original.length);
    // The decision is recorded as an empty marker, not as a duplicate of the
    // original: the next request skips the decode without paying twice the disk.
    const marker = await stat(join(avatarConfig.directory, storageKey, VARIANT_FILE));
    expect(marker.size).toBe(0);

    const repeat = await variants.open(avatar(storageKey, original.length));
    expect(await collect(repeat.stream)).toEqual(original);
  });

  it('derives once for concurrent first views of the same avatar', async () => {
    const original = await createPng(256, 90);
    const storageKey = await store(original);
    const readContent = jest.spyOn(storage, 'readContent');

    try {
      const contents = await Promise.all(
        Array.from({ length: 5 }, async () => variants.open(avatar(storageKey, original.length))),
      );
      const served = await Promise.all(contents.map(async (content) => collect(content.stream)));

      // A burst of first views must not each buffer and decode the original:
      // that turns a streaming route into a memory and threadpool amplifier.
      expect(readContent).toHaveBeenCalledTimes(1);
      for (const bytes of served) {
        expect(bytes).toEqual(served[0]);
      }
    } finally {
      readContent.mockRestore();
    }
  });

  it('answers from the derived bytes when the variant cannot be stored', async () => {
    const original = await createPng(256, 120);
    const storageKey = await store(original);
    const openVariant = jest.spyOn(storage, 'openVariant').mockResolvedValue(null);

    try {
      const content = await variants.open(avatar(storageKey, original.length));
      const served = await collect(content.stream);

      expect(served.length).toBeLessThan(original.length);
      // The header must describe the body on this branch too, or the response
      // is truncated or hangs.
      expect(content.sizeBytes).toBe(served.length);
    } finally {
      openVariant.mockRestore();
    }
  });

  it('serves the stored original when the picture cannot be re-encoded', async () => {
    // Stored bytes that no decoder accepts: the route must still answer with
    // what it has rather than fail the whole file list.
    const original = Buffer.alloc(32 * 1024, 0x7f);
    const storageKey = await store(original);

    const content = await variants.open(avatar(storageKey, original.length));

    expect(await collect(content.stream)).toEqual(original);
    expect(content.sizeBytes).toBe(original.length);
  });

  it('keeps the source colour profile in the derived picture', async () => {
    const original = await sharp(await createPng(256, 20))
      .withMetadata({ icc: 'p3' })
      .png()
      .toBuffer();
    const storageKey = await store(original);

    const content = await variants.open(avatar(storageKey, original.length));

    const metadata = await sharp(await collect(content.stream)).metadata();
    expect(metadata.icc).toBeDefined();
  });

  it('drops a colour profile that costs more than the picture it describes', async () => {
    // 96 px on both sides, so the box guard alone would serve it whole, and a
    // megabyte of colour profile that a 24 px row cannot possibly use.
    const original = await withIccProfile(await createPng(96, 20), 1024 * 1024);
    const storageKey = await store(original);

    const content = await variants.open(avatar(storageKey, original.length));
    const served = await collect(content.stream);

    // Carrying the profile over would leave the variant the size of the
    // original, which is the per-view cost the variant exists to remove.
    expect(served.length).toBeLessThan(16 * 1024);
    expect(content.sizeBytes).toBe(served.length);
    const metadata = await sharp(served).metadata();
    expect(metadata.width).toBe(96);
  });

  it('retries a derivation that failed instead of recording it as a decision', async () => {
    const original = await createPng(256, 60);
    const storageKey = await store(original);
    // One derivation sees bytes no decoder accepts, the way a libvips hiccup or
    // memory pressure fails a decode that would otherwise succeed.
    const readContent = jest
      .spyOn(storage, 'readContent')
      .mockResolvedValueOnce(Buffer.alloc(32 * 1024, 0x7f));

    const failed = await variants.open(avatar(storageKey, original.length));
    expect(await collect(failed.stream)).toEqual(original);
    readContent.mockRestore();

    // A transient failure must not be published as the "already list-sized"
    // marker: that would pin this avatar to full-size delivery on every view
    // of every file list for as long as it is the user's picture.
    await expect(
      access(join(avatarConfig.directory, storageKey, VARIANT_FILE)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const served = await collect((await variants.open(avatar(storageKey, original.length))).stream);
    expect(served.length).toBeLessThan(original.length);
  });

  it('derives from the bytes it is handed at upload without reading the original again', async () => {
    const original = await createPng(256, 150);
    const storageKey = await store(original);
    const readContent = jest.spyOn(storage, 'readContent');

    try {
      await variants.prepare(storageKey, 'image/png', original);

      // The upload request already holds the picture it validated: reading it
      // back off disk would double the peak cost of every avatar upload.
      expect(readContent).not.toHaveBeenCalled();
      const variant = await stat(join(avatarConfig.directory, storageKey, VARIANT_FILE));
      expect(variant.size).toBeGreaterThan(0);
      expect(variant.size).toBeLessThan(original.length);
    } finally {
      readContent.mockRestore();
    }
  });

  it('reports a storage key whose object is gone as missing', async () => {
    const storageKey = `variant-${randomUUID()}`;

    await expect(variants.open(avatar(storageKey, 10))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
