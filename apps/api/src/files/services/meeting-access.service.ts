import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

export enum MeetingAccessRole {
  OWNER = 'OWNER',
  PARTICIPANT = 'PARTICIPANT',
}

@Injectable()
export class MeetingAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async requireAccess(meetingId: string, userId: string): Promise<MeetingAccessRole> {
    const meeting = await this.prisma.meeting.findFirst({
      where: {
        id: meetingId,
        OR: [{ ownerId: userId }, { participants: { some: { userId } } }],
      },
      select: { ownerId: true },
    });

    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }

    return meeting.ownerId === userId ? MeetingAccessRole.OWNER : MeetingAccessRole.PARTICIPANT;
  }

  async requireOwner(meetingId: string, userId: string): Promise<void> {
    const role = await this.requireAccess(meetingId, userId);

    if (role !== MeetingAccessRole.OWNER) {
      throw new ForbiddenException('Only the meeting owner can delete files');
    }
  }
}
