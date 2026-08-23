import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TaskService } from '../meeting-summary/services/task.service';
import { PrismaModule } from '../prisma/prisma.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { TaskTools } from './task-tools';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [McpController],
  providers: [McpService, TaskTools, TaskService],
})
export class McpModule {}
