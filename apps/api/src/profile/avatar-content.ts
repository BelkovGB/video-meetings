import { Readable } from 'node:stream';

/** The bytes of an avatar and their verified media type — never a storage key. */
export type AvatarContent = { mimeType: string; sizeBytes: number; stream: Readable };
