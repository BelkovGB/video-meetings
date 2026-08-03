import { Prisma } from '@prisma/client';

export const meetingSelect = {
  id: true,
  title: true,
  date: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MeetingSelect;
