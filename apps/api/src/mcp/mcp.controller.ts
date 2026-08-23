import { All, Controller, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { McpService } from './mcp.service';

/**
 * No authorization yet — any caller reaches every meeting's tasks, not just
 * their own. Locking this down to the caller's own session is next.
 */
@Controller('mcp')
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @All()
  async handle(@Req() req: Request, @Res({ passthrough: false }) res: Response): Promise<void> {
    const transport = await this.mcpService.createConnectedTransport();

    await transport.handleRequest(req, res, req.body);
  }
}
