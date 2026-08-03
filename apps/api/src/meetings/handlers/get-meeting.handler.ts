import { Injectable, NotFoundException } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../prisma/prisma.service';
import { meetingSelect } from '../models/meeting.select';
import { GetMeetingQuery } from '../queries/get-meeting.query';

@QueryHandler(GetMeetingQuery)
@Injectable()
export class GetMeetingHandler implements IQueryHandler<GetMeetingQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ id, ownerId }: GetMeetingQuery) {
    const meeting = await this.prisma.meeting.findFirst({
      where: { id, ownerId },
      select: meetingSelect,
    });

    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }

    return meeting;
  }
}
