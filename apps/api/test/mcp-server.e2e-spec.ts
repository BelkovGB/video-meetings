import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MeetingSummaryStatus } from '@prisma/client';
import { join } from 'node:path';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureHttpApplication } from '../src/http-application';
import { PrismaService } from '../src/prisma/prisma.service';

type UserSession = { accessToken: string };
type Meeting = { id: string };

// @modelcontextprotocol/sdk ships ESM-only and this test file compiles to
// CommonJS under ts-jest, same problem `import-mcp-sdk.ts` documents for the
// server side. `new Function` hides the import from CommonJS downlevelling so
// a real dynamic import runs instead of a `require` that would fail.
const importMcpClientModule = new Function(
  'return import("@modelcontextprotocol/sdk/client/index.js")',
) as () => Promise<typeof import('@modelcontextprotocol/sdk/client/index.js')>;
const importMcpStdioClientModule = new Function(
  'return import("@modelcontextprotocol/sdk/client/stdio.js")',
) as () => Promise<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>;

const validPassword = 'secure-password-123';

function createUniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

describe('MCP server (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    configureHttpApplication(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerUser(prefix: string): Promise<UserSession> {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: createUniqueEmail(prefix), password: validPassword })
      .expect(201);

    return response.body as UserSession;
  }

  async function createMeeting(owner: UserSession): Promise<Meeting> {
    const response = await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'MCP e2e meeting', date: '2026-08-03T10:00:00.000Z' })
      .expect(201);

    return response.body as Meeting;
  }

  /** Connects a real MCP client to the standalone server over stdio, run
   * through ts-node against the TypeScript source directly so the test
   * exercises the same code the rest of this suite type-checks and lints,
   * without depending on a prior `nest build`. */
  async function connectMcpClient(accessToken: string) {
    const { Client } = await importMcpClientModule();
    const { StdioClientTransport } = await importMcpStdioClientModule();

    const client = new Client({ name: 'mcp-server-e2e', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-r', 'ts-node/register/transpile-only', join(__dirname, '../src/mcp-server/main.ts')],
      cwd: join(__dirname, '..'),
      env: { ...process.env, VIDEO_MEETINGS_ACCESS_TOKEN: accessToken } as Record<string, string>,
    });

    await client.connect(transport);

    return client;
  }

  it('lists find_tasks and returns a task for a meeting the caller owns', async () => {
    const owner = await registerUser('mcp-owner');
    const meeting = await createMeeting(owner);
    const summary = await prisma.meetingSummary.create({
      data: { meetingId: meeting.id, status: MeetingSummaryStatus.COMPLETED, summaryText: 'test' },
    });
    await prisma.meetingSummaryTask.create({
      data: {
        summaryId: summary.id,
        title: 'Ship the release notes',
        assignee: 'Vasya',
        position: 0,
      },
    });

    const client = await connectMcpClient(owner.accessToken);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('find_tasks');

      const result = await client.callTool({
        name: 'find_tasks',
        arguments: { summaryId: summary.id, query: 'release' },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0].text) as { tasks: Array<{ title: string }> };
      expect(payload.tasks).toEqual([expect.objectContaining({ title: 'Ship the release notes' })]);
    } finally {
      await client.close();
    }
  });

  it('refuses find_tasks for a meeting the caller does not own or participate in', async () => {
    const owner = await registerUser('mcp-owner');
    const stranger = await registerUser('mcp-stranger');
    const meeting = await createMeeting(owner);
    const summary = await prisma.meetingSummary.create({
      data: { meetingId: meeting.id, status: MeetingSummaryStatus.COMPLETED, summaryText: 'test' },
    });

    const client = await connectMcpClient(stranger.accessToken);

    try {
      const result = await client.callTool({
        name: 'find_tasks',
        arguments: { summaryId: summary.id, query: 'release' },
      });

      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
