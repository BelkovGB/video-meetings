import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { MeetingFileCategory } from '@prisma/client';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { contentValidators } from './content-validators';
import { uploadConfig } from '../upload.config';

type AllowedFile = {
  category: MeetingFileCategory;
  extension: string;
  mimeTypes: readonly string[];
};

const allowedFiles: readonly AllowedFile[] = [
  { category: 'AUDIO', extension: '.mp3', mimeTypes: ['audio/mpeg'] },
  { category: 'AUDIO', extension: '.m4a', mimeTypes: ['audio/mp4', 'audio/x-m4a'] },
  { category: 'AUDIO', extension: '.wav', mimeTypes: ['audio/wav', 'audio/x-wav'] },
  { category: 'AUDIO', extension: '.ogg', mimeTypes: ['audio/ogg', 'application/ogg'] },
  { category: 'VIDEO', extension: '.mp4', mimeTypes: ['video/mp4'] },
  { category: 'VIDEO', extension: '.webm', mimeTypes: ['video/webm'] },
  { category: 'VIDEO', extension: '.mov', mimeTypes: ['video/quicktime'] },
  { category: 'TRANSCRIPT', extension: '.txt', mimeTypes: ['text/plain'] },
  { category: 'TRANSCRIPT', extension: '.vtt', mimeTypes: ['text/vtt'] },
  { category: 'TRANSCRIPT', extension: '.srt', mimeTypes: ['application/x-subrip', 'text/plain'] },
  { category: 'DOCUMENT', extension: '.pdf', mimeTypes: ['application/pdf'] },
  {
    category: 'DOCUMENT',
    extension: '.docx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
];

export function unsupportedFileType(): UnsupportedMediaTypeException {
  return new UnsupportedMediaTypeException({
    message: 'Unsupported file type',
    code: 'UNSUPPORTED_FILE_TYPE',
  });
}

function isSafeOriginalName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    basename(name) === name &&
    !name.includes('\\') &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32)
  );
}

export function getDeclaredFile(
  file: Pick<Express.Multer.File, 'originalname' | 'mimetype'>,
): AllowedFile {
  if (!isSafeOriginalName(file.originalname)) {
    throw unsupportedFileType();
  }

  const extension = extname(file.originalname).toLowerCase();
  const allowedFile = allowedFiles.find(
    (candidate) => candidate.extension === extension && candidate.mimeTypes.includes(file.mimetype),
  );

  if (!allowedFile) {
    throw unsupportedFileType();
  }

  return allowedFile;
}

@Injectable()
export class MeetingFileValidationService {
  async validate(file: Express.Multer.File): Promise<AllowedFile> {
    const allowedFile = getDeclaredFile(file);

    if (file.size === 0) {
      throw new BadRequestException({ message: 'Uploaded file is empty', code: 'EMPTY_UPLOAD' });
    }

    if (file.size > uploadConfig.maxBytes) {
      throw new PayloadTooLargeException({
        message: 'Uploaded file is too large',
        code: 'UPLOAD_TOO_LARGE',
      });
    }

    const content = await this.readPrefix(file.path);
    const isValid = await this.hasExpectedContent(allowedFile, content, file.path);

    if (!isValid) {
      throw unsupportedFileType();
    }

    return allowedFile;
  }

  private async readPrefix(filePath: string): Promise<Buffer> {
    const handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(65_536);

    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async hasExpectedContent(
    allowedFile: AllowedFile,
    content: Buffer,
    filePath: string,
  ): Promise<boolean> {
    const validate = contentValidators[allowedFile.extension];
    // An extension with no validator is refused: the registry, not this
    // method, decides what is accepted.
    return validate ? validate(content, filePath) : false;
  }
}
