import { MeetingFile, Prisma, TranscriptionJobStatus } from '@prisma/client';

import {
  UserIdentityResponse,
  toUserIdentityResponse,
  userIdentitySelect,
} from '../../users/models/user-identity.response';

export const meetingFileSelect = {
  id: true,
  meetingId: true,
  originalName: true,
  category: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  uploadedBy: { select: userIdentitySelect },
  transcriptionJob: { select: { status: true } },
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
};

type SelectedMeetingFile = Prisma.MeetingFileGetPayload<{ select: typeof meetingFileSelect }>;

const transcriptionStatusByJobStatus: Record<TranscriptionJobStatus, TranscriptionStatus> = {
  [TranscriptionJobStatus.QUEUED]: 'queued',
  [TranscriptionJobStatus.PROCESSING]: 'processing',
  [TranscriptionJobStatus.COMPLETED]: 'ready',
  [TranscriptionJobStatus.FAILED]: 'error',
};

export function toMeetingFileResponse(file: SelectedMeetingFile): MeetingFileResponse {
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
    transcriptionStatus: file.transcriptionJob
      ? transcriptionStatusByJobStatus[file.transcriptionJob.status]
      : null,
  };
}
