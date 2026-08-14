import { Injectable } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateMeetingCommand } from '../commands/create-meeting.command';
import { meetingSelect } from '../models/meeting.select';

@CommandHandler(CreateMeetingCommand)
@Injectable()
export class CreateMeetingHandler implements ICommandHandler<CreateMeetingCommand> {
  constructor(private readonly prisma: PrismaService) {}

  execute({ title, date, ownerId }: CreateMeetingCommand) {
    return this.prisma.meeting.create({
      data: { title, date: new Date(date), ownerId },
      select: meetingSelect,
    });
  }
}
