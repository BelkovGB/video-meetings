import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MeetingSummaryService } from './services/meeting-summary.service';

@Controller('meetings/:meetingId/summary')
@UseGuards(JwtAuthGuard)
export class MeetingSummaryController {
  constructor(private readonly summary: MeetingSummaryService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Param('meetingId') meetingId: string, @Req() request: AuthenticatedRequest) {
    return this.summary.start(meetingId, request.user.sub);
  }

  @Get()
  get(@Param('meetingId') meetingId: string, @Req() request: AuthenticatedRequest) {
    return this.summary.get(meetingId, request.user.sub);
  }
}
