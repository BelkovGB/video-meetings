import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MeetingSummaryStatus } from '@prisma/client';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureHttpApplication } from '../src/http-application';
import { PrismaService } from '../src/prisma/prisma.service';

type UserSession = { accessToken: string; userId: string };
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
    const email = createUniqueEmail(prefix);
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: validPassword })
      .expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });

    return { accessToken: (response.body as { accessToken: string }).accessToken, userId: user.id };
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
   * `beforeAll`. The session's bearer token rides on every request the
   * transport makes: the endpoint is behind the same guard as the REST
   * routes, and it is that session that decides which meetings the tools
   * answer for. */
  async function connectMcpClient(session: UserSession) {
    const { Client } = await importMcpClientModule();
    const { StreamableHTTPClientTransport } = await importMcpStreamableHttpClientModule();

    const client = new Client({ name: 'mcp-e2e', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${session.accessToken}` } },
    });

    await client.connect(transport);

    return client;
  }

  /** A meeting with a finished summary, owned by the given user. */
  async function createSummary(owner: UserSession): Promise<{ id: string }> {
    const meeting = await createMeeting(owner);

    return prisma.meetingSummary.create({
      data: { meetingId: meeting.id, status: MeetingSummaryStatus.COMPLETED, summaryText: 'test' },
    });
  }

  it('lists find_tasks and upsert_task with their read-only annotations', async () => {
    const owner = await registerUser('mcp-owner');
    const client = await connectMcpClient(owner);

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

  it('offers the gather_meeting_tasks prompt', async () => {
    const owner = await registerUser('mcp-owner');
    const client = await connectMcpClient(owner);

    try {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toContain('gather_meeting_tasks');

      const result = await client.getPrompt({
        name: 'gather_meeting_tasks',
        arguments: { summaryId: 'a-summary-id' },
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({ role: 'user' });
      const content = result.messages[0].content as { type: string; text: string };
      expect(content.text).toContain('a-summary-id');
      expect(content.text).toContain('find_tasks');
      expect(content.text).toContain('upsert_task');
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
        {
          summaryId: summary.id,
          title: 'Ship the release notes',
          assignee: 'Vasya',
          position: 0,
          ownerId: owner.userId,
        },
        {
          summaryId: summary.id,
          title: 'Update the changelog',
          assignee: 'Petya',
          position: 1,
          ownerId: owner.userId,
        },
      ],
    });

    const client = await connectMcpClient(owner);

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

    const client = await connectMcpClient(owner);

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
        ownerId: owner.userId,
      },
    });
    const doneTask = await prisma.meetingSummaryTask.create({
      data: {
        summaryId: summary.id,
        title: 'Already shipped',
        assignee: 'Vasya',
        position: 1,
        status: 'DONE',
        ownerId: owner.userId,
      },
    });

    const client = await connectMcpClient(owner);

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
  it('keeps the assignee the transcript recorded when a client only flips the status', async () => {
    const owner = await registerUser('mcp-owner');
    const summary = await createSummary(owner);
    const task = await prisma.meetingSummaryTask.create({
      data: {
        summaryId: summary.id,
        title: 'Ship the release notes',
        assignee: 'Vasya',
        position: 0,
        status: 'TODO',
        ownerId: owner.userId,
      },
    });

    const client = await connectMcpClient(owner);

    try {
      // The tool takes no assignee at all, so the only assignee this update
      // can end with is the one already stored.
      const updated = await client.callTool({
        name: 'upsert_task',
        arguments: { summaryId: summary.id, taskId: task.id, title: task.title, status: 'DONE' },
      });

      expect(updated.isError).toBeFalsy();
      const stored = await prisma.meetingSummaryTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(stored).toMatchObject({ assignee: 'Vasya', status: 'DONE' });
    } finally {
      await client.close();
    }
  });

  it('refuses a connection that carries no session token', async () => {
    const { Client } = await importMcpClientModule();
    const { StreamableHTTPClientTransport } = await importMcpStreamableHttpClientModule();
    const client = new Client({ name: 'mcp-e2e-anonymous', version: '0.0.1' });

    await expect(client.connect(new StreamableHTTPClientTransport(mcpUrl))).rejects.toThrow();
  });

  it("scopes reads to the caller's own tasks and refuses a write into a stranger's meeting", async () => {
    const owner = await registerUser('mcp-owner');
    const outsider = await registerUser('mcp-outsider');
    const summary = await createSummary(owner);
    const ownersTask = await prisma.meetingSummaryTask.create({
      data: { summaryId: summary.id, title: "Owner's task", position: 0, ownerId: owner.userId },
    });

    const outsiderClient = await connectMcpClient(outsider);

    try {
      // summaryId says where to search, not whose eyes may search it: the
      // outsider's find_tasks succeeds, it just sees none of the owner's tasks.
      const found = await outsiderClient.callTool({
        name: 'find_tasks',
        arguments: { summaryId: summary.id, query: '' },
      });
      expect(found.isError).toBeFalsy();
      const foundContent = found.content as Array<{ type: string; text: string }>;
      const foundPayload = JSON.parse(foundContent[0].text) as { tasks: Array<{ id: string }> };
      expect(foundPayload.tasks.map((task) => task.id)).not.toContain(ownersTask.id);

      // Writing is a different question from reading: the row's owner is
      // stamped from the caller, so summaryId alone would decide whose
      // meeting the task lands in. A caller outside the meeting is refused,
      // and nothing is written — an MCP-origin row would otherwise survive
      // every rerun with no route to delete it.
      const written = await outsiderClient.callTool({
        name: 'upsert_task',
        arguments: { summaryId: summary.id, title: 'Filed by the outsider', status: 'TODO' },
      });
      expect(written.isError).toBe(true);
      const writtenContent = written.content as Array<{ type: string; text: string }>;
      expect(writtenContent[0].text).toBe(`No summary ${summary.id} found.`);
      const storedForSummary = await prisma.meetingSummaryTask.count({
        where: { summaryId: summary.id },
      });
      expect(storedForSummary).toBe(1);

      // The same refusal covers an update aimed at someone else's task: the
      // taskId is real, and it is still the meeting check that stops the call
      // before ownership is ever consulted.
      const hijacked = await outsiderClient.callTool({
        name: 'upsert_task',
        arguments: {
          summaryId: summary.id,
          taskId: ownersTask.id,
          title: 'Rewritten by the outsider',
          status: 'DONE',
        },
      });
      expect(hijacked.isError).toBe(true);
      const untouched = await prisma.meetingSummaryTask.findUniqueOrThrow({
        where: { id: ownersTask.id },
      });
      expect(untouched).toMatchObject({ title: "Owner's task", status: 'TODO' });
    } finally {
      await outsiderClient.close();
    }

    // The owner's own view is unaffected: still only their own task.
    const ownerClient = await connectMcpClient(owner);

    try {
      const ownerView = await ownerClient.callTool({
        name: 'find_tasks',
        arguments: { summaryId: summary.id, query: '' },
      });
      const ownerContent = ownerView.content as Array<{ type: string; text: string }>;
      const ownerPayload = JSON.parse(ownerContent[0].text) as { tasks: Array<{ id: string }> };
      expect(ownerPayload.tasks.map((task) => task.id)).toEqual([ownersTask.id]);
    } finally {
      await ownerClient.close();
    }
  });

  it('lets a meeting participant file a task under that meeting summary', async () => {
    const owner = await registerUser('mcp-owner');
    const participant = await registerUser('mcp-participant');
    const meeting = await createMeeting(owner);
    const summary = await prisma.meetingSummary.create({
      data: { meetingId: meeting.id, status: MeetingSummaryStatus.COMPLETED, summaryText: 'test' },
    });
    // The write rule is owner-or-participant, the same one the meeting-file
    // routes apply; without this case a rule narrowed to "owner only" would
    // still pass the suite.
    await prisma.meetingParticipant.create({
      data: { meetingId: meeting.id, userId: participant.userId },
    });

    const client = await connectMcpClient(participant);

    try {
      const written = await client.callTool({
        name: 'upsert_task',
        arguments: { summaryId: summary.id, title: 'Filed by a participant', status: 'TODO' },
      });

      expect(written.isError).toBeFalsy();
      const content = written.content as Array<{ type: string; text: string }>;
      const task = JSON.parse(content[0].text) as { id: string };
      const stored = await prisma.meetingSummaryTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(stored).toMatchObject({ ownerId: participant.userId, origin: 'MCP' });
    } finally {
      await client.close();
    }
  });

  it("marks the agent's task as MCP-written once a client edits it, so a rerun keeps the edit", async () => {
    const owner = await registerUser('mcp-owner');
    const summary = await createSummary(owner);
    // What the summary run itself writes: owned by the meeting's owner and
    // deleted by the next rerun, which is right until someone edits it.
    const agentTask = await prisma.meetingSummaryTask.create({
      data: {
        summaryId: summary.id,
        title: 'Подготовить отчёт',
        position: 0,
        ownerId: owner.userId,
        origin: 'AGENT',
      },
    });

    const client = await connectMcpClient(owner);

    try {
      const updated = await client.callTool({
        name: 'upsert_task',
        arguments: {
          summaryId: summary.id,
          taskId: agentTask.id,
          title: 'Подготовить отчёт и согласовать с юристами',
          status: 'DONE',
        },
      });

      expect(updated.isError).toBeFalsy();
      const stored = await prisma.meetingSummaryTask.findUniqueOrThrow({
        where: { id: agentTask.id },
      });
      // AGENT would put the edited row back under the rerun's delete, which
      // clears exactly the AGENT-origin tasks of the summary.
      expect(stored).toMatchObject({
        origin: 'MCP',
        title: 'Подготовить отчёт и согласовать с юристами',
        status: 'DONE',
      });
    } finally {
      await client.close();
    }
  });

  it("keeps another meeting's tasks out of tasks://open and task://{id}", async () => {
    const owner = await registerUser('mcp-owner');
    const outsider = await registerUser('mcp-outsider');
    const summary = await createSummary(owner);
    const task = await prisma.meetingSummaryTask.create({
      data: {
        summaryId: summary.id,
        title: 'Ship the release notes',
        position: 0,
        status: 'TODO',
        ownerId: owner.userId,
      },
    });

    const client = await connectMcpClient(outsider);

    try {
      const openList = await client.readResource({ uri: 'tasks://open' });
      const openContent = openList.contents[0] as { text: string };
      const openPayload = JSON.parse(openContent.text) as { tasks: Array<{ id: string }> };
      expect(openPayload.tasks.map((open) => open.id)).not.toContain(task.id);

      // Distinct from the 404 a truly missing id gets: this one exists, it's
      // just not the outsider's.
      await expect(client.readResource({ uri: `task://${task.id}` })).rejects.toThrow(/403/);
    } finally {
      await client.close();
    }
  });
});
