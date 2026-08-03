import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MeetingsController } from './meetings.controller';
import { CreateMeetingHandler } from './handlers/create-meeting.handler';
import { GetMeetingHandler } from './handlers/get-meeting.handler';
import { GetMeetingsHandler } from './handlers/get-meetings.handler';

const commandHandlers = [CreateMeetingHandler];
const queryHandlers = [GetMeetingHandler, GetMeetingsHandler];

@Module({
  imports: [AuthModule, CqrsModule, PrismaModule],
  controllers: [MeetingsController],
  providers: [...commandHandlers, ...queryHandlers],
})
export class MeetingsModule {}
