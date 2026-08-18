/**
 * Response contracts of the API as the browser consumes them.
 *
 * These are plain TypeScript types on purpose: Nest DTO classes must not be
 * imported into browser code. If the contract ever needs to be shared across
 * workspaces, generate it from OpenAPI rather than importing server classes.
 */

/** Error body returned by the API. `message` is an array for field validation. */
export type ApiError = {
  message?: string | string[];
};

/**
 * Errors that carry a machine-readable discriminator. `code` identifies the
 * failure, and `fields` names the rejected request properties of a
 * `VALIDATION_FAILED` response. A caller that shows localized text must key off
 * these instead of the English `message`, which is free to be reworded.
 *
 * Read by the meeting file upload and by the password-change form; every other
 * caller keys off `message` and status.
 */
export type CodedApiError = ApiError & {
  code?: string;
  fields?: string[];
  /**
   * Seconds left on a rate-limit window, mirroring the `Retry-After` header.
   * The header is not exposed to browser code by `app.enableCors(...)`, so a
   * screen that wants to quote the wait reads it here.
   */
  retryAfterSeconds?: number;
};

export type Avatar = {
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
};

export type CurrentUserProfile = {
  email: string;
  displayName: string | null;
  avatar: Avatar | null;
};

/**
 * The only user fields the API shares with another user, mirroring
 * `uploadedBy` of a meeting file. Email and every other private profile value
 * stay on the server, so nothing here may be widened without the API widening
 * `userIdentitySelect` first.
 */
export type UserIdentity = {
  displayName: string | null;
  avatar: { updatedAt: string } | null;
};

export type Meeting = {
  id: string;
  title: string;
  date: string;
  accessRole: 'owner' | 'participant';
};

export type MeetingFileCategory = 'audio' | 'video' | 'transcript' | 'document';

export type MeetingFile = {
  id: string;
  name: string;
  category: MeetingFileCategory;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  /** `null` once the uploading account no longer exists; the file stays listed. */
  uploadedBy: UserIdentity | null;
};
