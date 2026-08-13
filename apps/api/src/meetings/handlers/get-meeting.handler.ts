import { Injectable, NotFoundException } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../prisma/prisma.service';
import { meetingSelect } from '../models/meeting.select';
import { GetMeetingQuery } from '../queries/get-meeting.query';

@QueryHandler(GetMeetingQuery)
@Injectable()
export class GetMeetingHandler implements IQueryHandler<GetMeetingQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ id, userId }: GetMeetingQuery) {
    const meeting = await this.prisma.meeting.findFirst({
      where: {
        id,
        OR: [{ ownerId: userId }, { participants: { some: { userId } } }],
      },
      select: { ...meetingSelect, ownerId: true },
    });

    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }

    const { ownerId, ...response } = meeting;

    return {
      ...response,
      accessRole: ownerId === userId ? 'owner' : 'participant',
    };
  }
}
