import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { MeetingFileCategory } from '@prisma/client';
import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

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

function hasPrefix(content: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => content[index] === value);
}

function readsAscii(content: Buffer, offset: number, value: string): boolean {
  return content.subarray(offset, offset + value.length).toString('ascii') === value;
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
    switch (allowedFile.extension) {
      case '.mp3':
        return (
          readsAscii(content, 0, 'ID3') || (content[0] === 0xff && (content[1] & 0xe0) === 0xe0)
        );
      case '.m4a':
        return (
          readsAscii(content, 4, 'ftyp') &&
          ['M4A ', 'M4B ', 'M4P '].includes(content.subarray(8, 12).toString('ascii'))
        );
      case '.wav':
        return readsAscii(content, 0, 'RIFF') && readsAscii(content, 8, 'WAVE');
      case '.ogg':
        return readsAscii(content, 0, 'OggS');
      case '.mp4':
        return readsAscii(content, 4, 'ftyp') && !readsAscii(content, 8, 'qt  ');
      case '.webm':
        return hasPrefix(content, [0x1a, 0x45, 0xdf, 0xa3]) && content.includes('webm');
      case '.mov':
        return readsAscii(content, 4, 'ftyp') && readsAscii(content, 8, 'qt  ');
      case '.txt':
        return this.isPlainText(content);
      case '.vtt':
        return this.isPlainText(content) && content.toString('utf8').startsWith('WEBVTT');
      case '.srt':
        return (
          this.isPlainText(content) &&
          /^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(content.toString('utf8'))
        );
      case '.pdf':
        return readsAscii(content, 0, '%PDF-');
      case '.docx':
        return (
          hasPrefix(content, [0x50, 0x4b, 0x03, 0x04]) && (await this.hasDocxEntries(filePath))
        );
      default:
        return false;
    }
  }

  private isPlainText(content: Buffer): boolean {
    if (content.includes(0)) {
      return false;
    }

    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
      return true;
    } catch {
      return false;
    }
  }

  private async hasDocxEntries(filePath: string): Promise<boolean> {
    const fileStats = await stat(filePath);
    const length = Math.min(fileStats.size, 65_557);
    const handle = await open(filePath, 'r');
    const tail = Buffer.alloc(length);

    try {
      await handle.read(tail, 0, length, fileStats.size - length);
    } finally {
      await handle.close();
    }

    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0 || eocd + 22 > tail.length) {
      return false;
    }

    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directorySize > 1_048_576) {
      return false;
    }

    const directory = Buffer.alloc(directorySize);
    const directoryHandle = await open(filePath, 'r');
    try {
      const { bytesRead } = await directoryHandle.read(
        directory,
        0,
        directorySize,
        directoryOffset,
      );
      if (bytesRead !== directorySize) {
        return false;
      }
    } finally {
      await directoryHandle.close();
    }

    const entries = new Set<string>();
    let offset = 0;
    while (offset + 46 <= directory.length && directory.readUInt32LE(offset) === 0x02014b50) {
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const nameEnd = offset + 46 + nameLength;
      if (nameEnd > directory.length) {
        return false;
      }
      entries.add(directory.subarray(offset + 46, nameEnd).toString('utf8'));
      offset = nameEnd + extraLength + commentLength;
    }

    return entries.has('[Content_Types].xml') && entries.has('word/document.xml');
  }
}
