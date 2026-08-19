import { Readable } from 'node:stream';

/**
 * The bytes of an avatar and their verified media type — never a storage key.
 * A derived variant carries no version of its own, so this is what the storage
 * and the variant layer speak in.
 */
export type AvatarBytes = { mimeType: string; sizeBytes: number; stream: Readable };

/**
 * The bytes together with the version they belong to. The version comes from
 * the same row read as the storage key, so a caller that labels the body with
 * it names the bytes it actually streamed even when the avatar is replaced
 * around the call.
 */
export type AvatarContent = AvatarBytes & { updatedAt: Date };
