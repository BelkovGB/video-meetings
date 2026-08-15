import { open, stat } from 'node:fs/promises';

/**
 * Minimal ZIP central-directory reader for DOCX packages.
 *
 * A DOCX is an OPC package, so the signature check alone is not enough: a plain
 * renamed ZIP passes it. This reads the end-of-central-directory record and the
 * directory itself to confirm the two entries every DOCX must contain.
 *
 * The bounds are security limits, not tuning knobs, and are preserved exactly:
 * the EOCD is searched in the last 65 557 bytes (22-byte record plus the maximum
 * 65 535-byte comment), the central directory is refused above 1 MiB, and a name
 * running past the directory aborts the scan.
 */

const localSignatureBytes = [0x50, 0x4b, 0x03, 0x04] as const;
const centralDirectorySignature = 0x02014b50;
const endOfCentralDirectorySignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const endOfCentralDirectoryLength = 22;
const maxEndOfCentralDirectorySearch = 65_557;
const maxCentralDirectoryBytes = 1_048_576;
const centralDirectoryEntryHeaderLength = 46;

const requiredEntries = ['[Content_Types].xml', 'word/document.xml'] as const;

export function hasZipLocalFileSignature(content: Buffer): boolean {
  return localSignatureBytes.every((value, index) => content[index] === value);
}

async function readCentralDirectory(filePath: string): Promise<Buffer | null> {
  const fileStats = await stat(filePath);
  const length = Math.min(fileStats.size, maxEndOfCentralDirectorySearch);
  const handle = await open(filePath, 'r');
  const tail = Buffer.alloc(length);

  try {
    await handle.read(tail, 0, length, fileStats.size - length);
  } finally {
    await handle.close();
  }

  const eocd = tail.lastIndexOf(endOfCentralDirectorySignature);
  if (eocd < 0 || eocd + endOfCentralDirectoryLength > tail.length) {
    return null;
  }

  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (directorySize > maxCentralDirectoryBytes) {
    return null;
  }

  const directory = Buffer.alloc(directorySize);
  const directoryHandle = await open(filePath, 'r');
  try {
    const { bytesRead } = await directoryHandle.read(directory, 0, directorySize, directoryOffset);
    if (bytesRead !== directorySize) {
      return null;
    }
  } finally {
    await directoryHandle.close();
  }

  return directory;
}

function entryNames(directory: Buffer): Set<string> | null {
  const entries = new Set<string>();
  let offset = 0;

  while (
    offset + centralDirectoryEntryHeaderLength <= directory.length &&
    directory.readUInt32LE(offset) === centralDirectorySignature
  ) {
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const nameEnd = offset + centralDirectoryEntryHeaderLength + nameLength;
    if (nameEnd > directory.length) {
      return null;
    }
    entries.add(
      directory.subarray(offset + centralDirectoryEntryHeaderLength, nameEnd).toString('utf8'),
    );
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

export async function hasDocxEntries(filePath: string): Promise<boolean> {
  const directory = await readCentralDirectory(filePath);
  if (!directory) {
    return false;
  }

  const entries = entryNames(directory);
  return entries !== null && requiredEntries.every((entry) => entries.has(entry));
}
