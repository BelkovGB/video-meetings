import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { FilesModule } from '../files/files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MeetingSummaryController } from './meeting-summary.controller';
import { MeetingToolsService } from './meeting-tools';
import { MeetingSummaryReconciliationService } from './services/meeting-summary-reconciliation.service';
import { MeetingSummaryRunnerService } from './services/meeting-summary-runner.service';
import { MeetingSummaryService } from './services/meeting-summary.service';

@Module({
  imports: [AuthModule, PrismaModule, FilesModule, ClaudeAgentModule],
  controllers: [MeetingSummaryController],
  providers: [
    MeetingSummaryService,
    MeetingSummaryRunnerService,
    MeetingSummaryReconciliationService,
    MeetingToolsService,
  ],
})
export class MeetingSummaryModule {}
