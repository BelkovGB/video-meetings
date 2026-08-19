import { MeetingFile, Prisma } from '@prisma/client';

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
} satisfies Prisma.MeetingFileSelect;

export type MeetingFileResponse = {
  id: string;
  name: string;
  category: Lowercase<MeetingFile['category']>;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: Date;
  uploadedBy: UserIdentityResponse | null;
};

type SelectedMeetingFile = Prisma.MeetingFileGetPayload<{ select: typeof meetingFileSelect }>;

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
  };
}
