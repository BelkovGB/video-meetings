import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname } from 'node:path';

const loadModule = createRequire(__filename);
const sharp = loadModule('sharp') as typeof import('sharp').default;

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
    if (!(await this.hasExpectedContent(extension, content))) {
      throw unsupportedAvatarType();
    }

    return { mimeType: allowedType.mimeType, sizeBytes: file.size };
  }

  private async hasExpectedContent(
    extension: keyof typeof avatarTypes,
    content: Buffer,
  ): Promise<boolean> {
    try {
      const image = sharp(content, { failOn: 'error', limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      const expectedFormat = extension === '.jpg' ? 'jpeg' : extension.slice(1);
      if (metadata.format !== expectedFormat) {
        return false;
      }

      await image.resize(1, 1, { fit: 'fill' }).toBuffer();
      return true;
    } catch {
      return false;
    }
  }
}
