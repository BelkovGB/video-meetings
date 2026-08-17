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
 * Upload errors additionally carry a machine-readable code. Only the meeting
 * file upload reads it; every other caller keys off `message` and status.
 */
export type UploadApiError = ApiError & {
  code?: string;
};

/**
 * Errors that carry a machine-readable discriminator. `code` identifies the
 * failure, and `fields` names the rejected request properties of a
 * `VALIDATION_FAILED` response. A caller that shows localized text must key off
 * these instead of the English `message`, which is free to be reworded.
 */
export type CodedApiError = ApiError & {
  code?: string;
  fields?: string[];
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
};
