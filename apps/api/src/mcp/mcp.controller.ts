import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { McpService } from './mcp.service';

/**
 * The same bearer token the REST routes take: the endpoint speaks MCP, not a
 * second authentication scheme. The session behind that token decides what
 * the tools and resources built for this one request can reach, so an
 * anonymous caller gets a 401 here rather than a server whose tools quietly
 * answer for every meeting in the database.
 */
@Controller('mcp')
@UseGuards(JwtAuthGuard)
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @All()
  async handle(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const transport = await this.mcpService.createConnectedTransport({ userId: req.user.sub });

    await transport.handleRequest(req, res, req.body);
  }
}
