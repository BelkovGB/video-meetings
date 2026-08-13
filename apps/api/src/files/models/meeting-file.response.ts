import { MeetingFile, Prisma } from '@prisma/client';

export const meetingFileSelect = {
  id: true,
  originalName: true,
  category: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
} satisfies Prisma.MeetingFileSelect;

export type MeetingFileResponse = {
  id: string;
  name: string;
  category: Lowercase<MeetingFile['category']>;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: Date;
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
  };
}
