import { Injectable } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../prisma/prisma.service';
import { meetingSelect } from '../models/meeting.select';
import { GetMeetingsQuery } from '../queries/get-meetings.query';

@QueryHandler(GetMeetingsQuery)
@Injectable()
export class GetMeetingsHandler implements IQueryHandler<GetMeetingsQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userId }: GetMeetingsQuery) {
    const meetings = await this.prisma.meeting.findMany({
      where: {
        OR: [{ ownerId: userId }, { participants: { some: { userId } } }],
      },
      orderBy: { createdAt: 'desc' },
      select: { ...meetingSelect, ownerId: true },
    });

    return meetings.map(({ ownerId, ...meeting }) => ({
      ...meeting,
      accessRole: ownerId === userId ? 'owner' : 'participant',
    }));
  }
}
