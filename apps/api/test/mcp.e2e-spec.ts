import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MeetingSummaryStatus } from '@prisma/client';
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
const importMcpStreamableHttpClientModule = new Function(
  'return import("@modelcontextprotocol/sdk/client/streamableHttp.js")',
) as () => Promise<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>;

const validPassword = 'secure-password-123';

function createUniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

describe('MCP server (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mcpUrl: URL;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    configureHttpApplication(app);
    await app.init();
    prisma = app.get(PrismaService);

    // The MCP client transport makes real HTTP requests, unlike supertest's
    // in-memory requests against `app.getHttpServer()` — the server needs an
    // actual listening port.
    await app.listen(0);
    const address = app.getHttpServer().address();
    mcpUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
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

  /** Connects a real MCP client to the in-process HTTP server over the
   * Streamable HTTP transport, against the real listening port from
   * `beforeAll`. */
  async function connectMcpClient() {
    const { Client } = await importMcpClientModule();
    const { StreamableHTTPClientTransport } = await importMcpStreamableHttpClientModule();

    const client = new Client({ name: 'mcp-e2e', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(mcpUrl);

    await client.connect(transport);

    return client;
  }

  it('lists find_tasks and upsert_task with their read-only annotations', async () => {
    const client = await connectMcpClient();

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['find_tasks', 'upsert_task']),
      );
      const findTasksTool = tools.find((tool) => tool.name === 'find_tasks');
      const upsertTaskTool = tools.find((tool) => tool.name === 'upsert_task');
      expect(findTasksTool?.annotations?.readOnlyHint).toBe(true);
      expect(upsertTaskTool?.annotations?.readOnlyHint).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('lists every task for a summary when find_tasks is called with an empty query', async () => {
    const owner = await registerUser('mcp-owner');
    const meeting = await createMeeting(owner);
    const summary = await prisma.meetingSummary.create({
      data: { meetingId: meeting.id, status: MeetingSummaryStatus.COMPLETED, summaryText: 'test' },
    });
    await prisma.meetingSummaryTask.createMany({
      data: [
        { summaryId: summary.id, title: 'Ship the release notes', assignee: 'Vasya', position: 0 },
        { summaryId: summary.id, title: 'Update the changelog', assignee: 'Petya', position: 1 },
      ],
    });

    const client = await connectMcpClient();

    try {
      const result = await client.callTool({
        name: 'find_tasks',
        arguments: { summaryId: summary.id, query: '' },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0].text) as { tasks: Array<{ title: string }> };
      expect(payload.tasks.map((task) => task.title)).toEqual(
        expect.arrayContaining(['Ship the release notes', 'Update the changelog']),
      );
    } finally {
      await client.close();
    }
  });

  it('creates and then updates a task through upsert_task', async () => {
    const owner = await registerUser('mcp-owner');
    const meeting = await createMeeting(owner);
    const summary = await prisma.meetingSummary.create({
      data: { meetingId: meeting.id, status: MeetingSummaryStatus.COMPLETED, summaryText: 'test' },
    });

    const client = await connectMcpClient();

    try {
      const created = await client.callTool({
        name: 'upsert_task',
        arguments: { summaryId: summary.id, title: 'Deploy the release', status: 'TODO' },
      });

      expect(created.isError).toBeFalsy();
      const createdContent = created.content as Array<{ type: string; text: string }>;
      const createdTask = JSON.parse(createdContent[0].text) as {
        id: string;
        title: string;
        status: string;
      };
      expect(createdTask).toMatchObject({ title: 'Deploy the release', status: 'TODO' });

      const updated = await client.callTool({
        name: 'upsert_task',
        arguments: {
          summaryId: summary.id,
          taskId: createdTask.id,
          title: 'Deploy the release',
          status: 'DONE',
        },
      });

      expect(updated.isError).toBeFalsy();
      const updatedContent = updated.content as Array<{ type: string; text: string }>;
      const updatedTask = JSON.parse(updatedContent[0].text) as { id: string; status: string };
      expect(updatedTask).toMatchObject({ id: createdTask.id, status: 'DONE' });

      const stored = await prisma.meetingSummaryTask.findUniqueOrThrow({
        where: { id: createdTask.id },
      });
      expect(stored.status).toBe('DONE');
    } finally {
      await client.close();
    }
  });

  it('offers the tasks://open resource and the task://{id} template', async () => {
    const owner = await registerUser('mcp-owner');
    const meeting = await createMeeting(owner);
    const summary = await prisma.meetingSummary.create({
      data: { meetingId: meeting.id, status: MeetingSummaryStatus.COMPLETED, summaryText: 'test' },
    });
    const openTask = await prisma.meetingSummaryTask.create({
      data: {
        summaryId: summary.id,
        title: 'Ship the release notes',
        assignee: 'Vasya',
        position: 0,
        status: 'TODO',
      },
    });
    const doneTask = await prisma.meetingSummaryTask.create({
      data: {
        summaryId: summary.id,
        title: 'Already shipped',
        assignee: 'Vasya',
        position: 1,
        status: 'DONE',
      },
    });

    const client = await connectMcpClient();

    try {
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toContain('tasks://open');

      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate)).toContain('task://{id}');

      const openList = await client.readResource({ uri: 'tasks://open' });
      const openContent = openList.contents[0] as { text: string };
      const openPayload = JSON.parse(openContent.text) as {
        tasks: Array<{ id: string }>;
      };
      expect(openPayload.tasks.map((task) => task.id)).toContain(openTask.id);
      expect(openPayload.tasks.map((task) => task.id)).not.toContain(doneTask.id);

      const single = await client.readResource({ uri: `task://${doneTask.id}` });
      const singleContent = single.contents[0] as { text: string };
      const singlePayload = JSON.parse(singleContent.text) as {
        id: string;
        status: string;
      };
      expect(singlePayload).toMatchObject({ id: doneTask.id, status: 'DONE' });

      await expect(client.readResource({ uri: 'task://does-not-exist' })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
