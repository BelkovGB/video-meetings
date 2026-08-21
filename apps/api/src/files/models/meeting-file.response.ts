import { MeetingFile, Prisma, TranscriptionJobStatus } from '@prisma/client';

import {
  UserIdentityResponse,
  toUserIdentityResponse,
  userIdentitySelect,
} from '../../users/models/user-identity.response';
import {
  TranscriptionFailureCode,
  transcriptionFailureCodes,
} from '../../transcription/models/transcription-failure';

export const meetingFileSelect = {
  id: true,
  meetingId: true,
  originalName: true,
  category: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  uploadedBy: { select: userIdentitySelect },
  transcriptionJob: { select: { status: true, failureCode: true } },
} satisfies Prisma.MeetingFileSelect;

export type TranscriptionStatus = 'queued' | 'processing' | 'ready' | 'error';

export type MeetingFileResponse = {
  id: string;
  name: string;
  category: Lowercase<MeetingFile['category']>;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: Date;
  uploadedBy: UserIdentityResponse | null;
  transcriptionStatus: TranscriptionStatus | null;
  transcriptionFailureCode: TranscriptionFailureCode | null;
};

type SelectedMeetingFile = Prisma.MeetingFileGetPayload<{ select: typeof meetingFileSelect }>;

const transcriptionStatusByJobStatus: Record<TranscriptionJobStatus, TranscriptionStatus> = {
  [TranscriptionJobStatus.QUEUED]: 'queued',
  [TranscriptionJobStatus.PROCESSING]: 'processing',
  [TranscriptionJobStatus.COMPLETED]: 'ready',
  [TranscriptionJobStatus.FAILED]: 'error',
};

export function toMeetingFileResponse(file: SelectedMeetingFile): MeetingFileResponse {
  const transcriptionStatus = file.transcriptionJob
    ? transcriptionStatusByJobStatus[file.transcriptionJob.status]
    : null;

  return {
    id: file.id,
    name: file.originalName,
    category: file.category.toLowerCase() as MeetingFileResponse['category'],
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    uploadedAt: file.createdAt,
    // The meeting scopes the uploader handle: the same person appears under one
    // handle within a meeting and under an unrelated one in every other.
    uploadedBy: toUserIdentityResponse(file.uploadedBy, file.meetingId),
    transcriptionStatus,
    transcriptionFailureCode:
      transcriptionStatus === 'error'
        ? toTranscriptionFailureCode(file.transcriptionJob?.failureCode ?? null)
        : null,
  };
}

// The column is a plain VARCHAR in the schema, and `failJob` only ever writes
// a `TranscriptionFailureCode`, but this response is the client-facing
// boundary: an unrecognised value (a hand-edited row, a restored backup) must
// not reach the client verbatim, so it is coerced to the generic code instead.
function toTranscriptionFailureCode(value: string | null): TranscriptionFailureCode | null {
  if (value === null) {
    return null;
  }

  return (transcriptionFailureCodes as readonly string[]).includes(value)
    ? (value as TranscriptionFailureCode)
    : 'INTERNAL_ERROR';
}
