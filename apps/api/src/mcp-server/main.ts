import { NotFoundException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';

import { AuthSessionService } from '../auth/services/auth-session.service';
import { MeetingAccessService } from '../files/services/meeting-access.service';
import { findSimilarTasks } from '../meeting-summary/find-similar-tasks';
import { PrismaService } from '../prisma/prisma.service';
import { importMcpServerModule, importMcpStdioModule } from './import-mcp-sdk';
import { verifyAccessToken } from './mcp-auth';
import { McpServerModule } from './mcp-server.module';

function requireAccessToken(): string {
  const token = process.env.VIDEO_MEETINGS_ACCESS_TOKEN;

  if (!token) {
    throw new Error(
      'VIDEO_MEETINGS_ACCESS_TOKEN is not set. Log in at POST /auth/login and pass the ' +
        'returned accessToken to this server through that environment variable.',
    );
  }

  return token;
}

async function bootstrap(): Promise<void> {
  const accessToken = requireAccessToken();

  // The stdio transport reserves stdout for JSON-RPC frames; Nest's default
  // logger writes to stdout too, so it's disabled here to avoid corrupting
  // the protocol stream.
  const context = await NestFactory.createApplicationContext(McpServerModule, {
    logger: false,
  });
  const prisma = context.get(PrismaService);
  const jwtService = context.get(JwtService);
  const authSessionService = context.get(AuthSessionService);
  const meetingAccessService = context.get(MeetingAccessService);

  const { McpServer } = await importMcpServerModule();
  const { StdioServerTransport } = await importMcpStdioModule();

  const server = new McpServer({ name: 'video-meetings', version: '0.1.0' });

  server.registerTool(
    'find_tasks',
    {
      title: 'Find meeting tasks',
      description:
        'Finds tasks recorded for a meeting summary whose title or assignee ' +
        'resembles the given text. Only works for a meeting the authenticated ' +
        'user owns or participates in.',
      inputSchema: {
        summaryId: z.string().min(1).describe('Id of the meeting summary to search within.'),
        query: z
          .string()
          .min(1)
          .describe('Free text to match against task titles and assignee names.'),
      },
    },
    async ({ summaryId, query }) => {
      // The caller supplies summaryId, but never their identity: userId comes
      // only from the token this process was started with, so a malicious or
      // confused MCP client cannot claim to be someone else's session.
      const userId = await verifyAccessToken(jwtService, authSessionService, accessToken);

      const summary = await prisma.meetingSummary.findUnique({
        where: { id: summaryId },
        select: { meetingId: true },
      });

      if (!summary) {
        throw new NotFoundException('Meeting summary not found');
      }

      await meetingAccessService.requireAccess(summary.meetingId, userId);

      const tasks = await findSimilarTasks(prisma, { summaryId, query });

      return { content: [{ type: 'text' as const, text: JSON.stringify({ tasks }) }] };
    },
  );

  const shutDown = async (): Promise<void> => {
    await context.close();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutDown());
  }

  await server.connect(new StdioServerTransport());
}

void bootstrap();
