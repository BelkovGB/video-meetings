import { hasDocxEntries, hasZipLocalFileSignature } from './docx-package.validator';

/**
 * Content validators keyed by extension.
 *
 * A declared extension and mime type are attacker-controlled, so every accepted
 * type must also prove itself from its bytes. Each validator receives the first
 * 64 KiB of the file and, when it needs more than a prefix, the path.
 *
 * A registry rather than a switch: adding a type is one entry, each validator is
 * independently readable, and an extension with no entry is refused by
 * construction instead of by a `default` branch.
 */

export type ContentValidator = (content: Buffer, filePath: string) => boolean | Promise<boolean>;

function hasPrefix(content: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => content[index] === value);
}

function readsAscii(content: Buffer, offset: number, value: string): boolean {
  return content.subarray(offset, offset + value.length).toString('ascii') === value;
}

/** ISO base media file format: a `ftyp` box at offset 4, then a four-byte brand. */
function isoBrand(content: Buffer): string {
  return content.subarray(8, 12).toString('ascii');
}

function isIsoContainer(content: Buffer): boolean {
  return readsAscii(content, 4, 'ftyp');
}

const quickTimeBrand = 'qt  ';

export function isPlainText(content: Buffer): boolean {
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

const subtitleCuePattern = /^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/;

export const contentValidators: Readonly<Record<string, ContentValidator>> = {
  // An ID3 tag, or a frame header whose first eleven bits are set.
  '.mp3': (content) =>
    readsAscii(content, 0, 'ID3') || (content[0] === 0xff && (content[1] & 0xe0) === 0xe0),
  '.m4a': (content) =>
    isIsoContainer(content) && ['M4A ', 'M4B ', 'M4P '].includes(isoBrand(content)),
  '.wav': (content) => readsAscii(content, 0, 'RIFF') && readsAscii(content, 8, 'WAVE'),
  '.ogg': (content) => readsAscii(content, 0, 'OggS'),
  // mp4 and mov share the ISO container; only the brand separates them.
  '.mp4': (content) => isIsoContainer(content) && isoBrand(content) !== quickTimeBrand,
  '.mov': (content) => isIsoContainer(content) && isoBrand(content) === quickTimeBrand,
  '.webm': (content) => hasPrefix(content, [0x1a, 0x45, 0xdf, 0xa3]) && content.includes('webm'),
  '.txt': (content) => isPlainText(content),
  '.vtt': (content) => isPlainText(content) && content.toString('utf8').startsWith('WEBVTT'),
  '.srt': (content) => isPlainText(content) && subtitleCuePattern.test(content.toString('utf8')),
  '.pdf': (content) => readsAscii(content, 0, '%PDF-'),
  '.docx': async (content, filePath) =>
    hasZipLocalFileSignature(content) && (await hasDocxEntries(filePath)),
};
