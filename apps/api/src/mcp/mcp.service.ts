import { Injectable } from '@nestjs/common';

import {
  importMcpServerModule,
  importMcpStreamableHttpModule,
  McpStreamableHttpModule,
} from '../mcp-sdk/import-mcp-sdk';
import { TaskTools } from './task-tools';

type McpHttpTransport = InstanceType<McpStreamableHttpModule['StreamableHTTPServerTransport']>;

/** The authenticated caller `McpController` resolved from the bearer token.
 * Carried down to every tool/resource so a caller-supplied id (summaryId,
 * taskId) stays "what to search", never "permission to see it" — see
 * `TaskService`'s class doc. */
export type McpRequester = { userId: string };

/**
 * Builds a fresh, connected MCP server + Streamable HTTP transport for every
 * call. This is not a stylistic choice: in stateless mode
 * (`sessionIdGenerator: undefined`) the SDK itself enforces one transport per
 * request — `WebStandardStreamableHTTPServerTransport.handleRequest` throws
 * "Stateless transport cannot be reused across requests" the second time a
 * transport handles a request. A transport built once and reused (e.g. from
 * `onModuleInit`) works for exactly one call and then fails every request
 * after it — confirmed by hand against a raw Node `http` server, a bare
 * Express app, and Nest in isolation, so it is not Nest- or Express-specific.
 * The failure is also silent: the thrown error rejects the promise
 * `@hono/node-server`'s Node bridge awaits internally, and that bridge
 * swallows it into an empty 500 with no server-side log line, so it would
 * otherwise look like a working server until a second request arrived.
 *
 * Deliberately no `OnModuleInit` warm-up of the SDK import, even though
 * `Nest.createApplicationContext`/`NestFactory.create` calls it on every app
 * boot: `AppModule` loads `McpModule` for every e2e spec, so an eager import
 * here ran on every one of them, not just the ones that call `/mcp` — and
 * this SDK's dynamic `import()` needs the exact same isolation
 * `importClaudeAgentSdk` documents, so an import in flight when Jest tears
 * down whichever spec triggered it corrupts every later spec's module
 * registry in the same `--runInBand` process. `ClaudeAgentService` avoids
 * this by only importing inside the method that needs it, never at module
 * init; `createConnectedTransport` does the same.
 */
@Injectable()
export class McpService {
  constructor(private readonly taskTools: TaskTools) {}

  /**
   * `requester` is the authenticated caller from `McpController`: the tools
   * and resources are registered for that user alone, which is what keeps a
   * caller-supplied summaryId or task id from reaching a task they do not
   * own. A fresh server per request is what makes that possible — one shared
   * server could not carry a per-caller identity.
   */
  async createConnectedTransport(requester: McpRequester): Promise<McpHttpTransport> {
    const { McpServer, ResourceTemplate } = await importMcpServerModule();
    const { StreamableHTTPServerTransport } = await importMcpStreamableHttpModule();

    const server = new McpServer({ name: 'video-meetings', version: '0.1.0' });
    this.taskTools.registerOn(server, ResourceTemplate, requester);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    return transport;
  }
}
