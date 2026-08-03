import { Injectable } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../prisma/prisma.service';
import { meetingSelect } from '../models/meeting.select';
import { GetMeetingsQuery } from '../queries/get-meetings.query';

@QueryHandler(GetMeetingsQuery)
@Injectable()
export class GetMeetingsHandler implements IQueryHandler<GetMeetingsQuery> {
  constructor(private readonly prisma: PrismaService) {}

  execute({ ownerId }: GetMeetingsQuery) {
    return this.prisma.meeting.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      select: meetingSelect,
    });
  }
}
