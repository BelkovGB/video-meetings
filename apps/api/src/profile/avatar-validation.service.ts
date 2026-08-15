import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { avatarConfig } from './avatar.config';

const avatarTypes = {
  '.jpeg': { mimeType: 'image/jpeg' },
  '.jpg': { mimeType: 'image/jpeg' },
  '.png': { mimeType: 'image/png' },
  '.webp': { mimeType: 'image/webp' },
} as const;

export type AvatarMetadata = { mimeType: string; sizeBytes: number };

function unsupportedAvatarType(): UnsupportedMediaTypeException {
  return new UnsupportedMediaTypeException({
    message: 'Unsupported avatar type',
    code: 'UNSUPPORTED_AVATAR_TYPE',
  });
}

function hasPrefix(content: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => content[index] === value);
}

@Injectable()
export class AvatarValidationService {
  async validate(file: Express.Multer.File | undefined): Promise<AvatarMetadata> {
    if (!file) {
      throw new BadRequestException({ message: 'Avatar is required', code: 'MISSING_AVATAR' });
    }
    if (file.size > avatarConfig.maxBytes) {
      throw new PayloadTooLargeException({
        message: 'Avatar is too large',
        code: 'AVATAR_TOO_LARGE',
      });
    }
    if (file.size === 0) {
      throw new BadRequestException({ message: 'Avatar is empty', code: 'EMPTY_AVATAR' });
    }

    const extension = extname(file.originalname).toLowerCase() as keyof typeof avatarTypes;
    const allowedType = avatarTypes[extension];
    if (!allowedType || file.mimetype !== allowedType.mimeType) {
      throw unsupportedAvatarType();
    }

    const content = await readFile(file.path);
    if (!this.hasExpectedContent(extension, content)) {
      throw unsupportedAvatarType();
    }

    return { mimeType: allowedType.mimeType, sizeBytes: file.size };
  }

  private hasExpectedContent(extension: keyof typeof avatarTypes, content: Buffer): boolean {
    switch (extension) {
      case '.jpeg':
      case '.jpg':
        return this.isJpeg(content);
      case '.png':
        return this.isPng(content);
      case '.webp':
        return this.isWebp(content);
    }
  }

  private isJpeg(content: Buffer): boolean {
    if (!hasPrefix(content, [0xff, 0xd8])) {
      return false;
    }

    let offset = 2;
    let hasFrame = false;
    let hasScan = false;
    while (offset < content.length) {
      if (content[offset++] !== 0xff) {
        return false;
      }
      while (content[offset] === 0xff) {
        offset++;
      }
      const marker = content[offset++];
      if (marker === 0xd9) {
        return hasFrame && hasScan && offset === content.length;
      }
      if (marker === 0xda) {
        hasScan = true;
        if (offset + 2 > content.length) {
          return false;
        }
        const length = content.readUInt16BE(offset);
        offset += length;
        if (length < 2 || offset > content.length) {
          return false;
        }
        for (; offset + 1 < content.length; offset++) {
          if (content[offset] !== 0xff) {
            continue;
          }
          const next = content[offset + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            offset++;
            continue;
          }
          if (next === 0xd9) {
            return hasFrame && offset + 2 === content.length;
          }
          break;
        }
        if (offset + 1 >= content.length) {
          return false;
        }
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > content.length) {
        return false;
      }
      const length = content.readUInt16BE(offset);
      if (length < 2 || offset + length > content.length) {
        return false;
      }
      hasFrame ||= marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      offset += length;
    }
    return false;
  }

  private isPng(content: Buffer): boolean {
    if (!hasPrefix(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return false;
    }

    let offset = 8;
    let hasHeader = false;
    let hasImageData = false;
    while (offset + 12 <= content.length) {
      const length = content.readUInt32BE(offset);
      const type = content.subarray(offset + 4, offset + 8).toString('ascii');
      const end = offset + 12 + length;
      if (end > content.length) {
        return false;
      }
      if (!hasHeader) {
        if (type !== 'IHDR' || length !== 13) {
          return false;
        }
        hasHeader = true;
      }
      hasImageData ||= type === 'IDAT' && length > 0;
      if (type === 'IEND') {
        return hasHeader && hasImageData && length === 0 && end === content.length;
      }
      offset = end;
    }
    return false;
  }

  private isWebp(content: Buffer): boolean {
    if (
      content.length < 20 ||
      !hasPrefix(content, [0x52, 0x49, 0x46, 0x46]) ||
      content.subarray(8, 12).toString('ascii') !== 'WEBP' ||
      content.readUInt32LE(4) + 8 !== content.length
    ) {
      return false;
    }

    let offset = 12;
    let hasImageChunk = false;
    while (offset + 8 <= content.length) {
      const type = content.subarray(offset, offset + 4).toString('ascii');
      const length = content.readUInt32LE(offset + 4);
      const end = offset + 8 + length;
      if (end > content.length) {
        return false;
      }
      const payloadOffset = offset + 8;
      hasImageChunk ||=
        (type === 'VP8 ' &&
          length >= 10 &&
          content
            .subarray(payloadOffset + 3, payloadOffset + 6)
            .equals(Buffer.from([0x9d, 0x01, 0x2a]))) ||
        (type === 'VP8L' && length >= 5 && content[payloadOffset] === 0x2f) ||
        (type === 'ANMF' && length >= 24);
      offset = end + (length % 2);
    }
    return hasImageChunk && offset === content.length;
  }
}
