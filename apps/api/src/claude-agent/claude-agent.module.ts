import { Module } from '@nestjs/common';

import { ClaudeAgentService } from './claude-agent.service';

@Module({
  providers: [ClaudeAgentService],
  exports: [ClaudeAgentService],
})
export class ClaudeAgentModule {}
