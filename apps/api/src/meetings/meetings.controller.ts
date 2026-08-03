import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateMeetingCommand } from './commands/create-meeting.command';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { GetMeetingQuery } from './queries/get-meeting.query';
import { GetMeetingsQuery } from './queries/get-meetings.query';

@Controller('meetings')
@UseGuards(JwtAuthGuard)
export class MeetingsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  create(@Body() createMeetingDto: CreateMeetingDto, @Req() request: AuthenticatedRequest) {
    return this.commandBus.execute(
      new CreateMeetingCommand(createMeetingDto.title, createMeetingDto.date, request.user.sub),
    );
  }

  @Get()
  findAll(@Req() request: AuthenticatedRequest) {
    return this.queryBus.execute(new GetMeetingsQuery(request.user.sub));
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.queryBus.execute(new GetMeetingQuery(id, request.user.sub));
  }
}
