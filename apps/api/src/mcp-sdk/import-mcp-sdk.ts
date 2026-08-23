export type McpServerModule = typeof import('@modelcontextprotocol/sdk/server/mcp.js');
export type McpStreamableHttpModule =
  typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js');

// Same problem and same fix as `importClaudeAgentSdk`: @modelcontextprotocol/sdk
// ships ESM-only and this app compiles to CommonJS. `new Function` hides the
// import from TypeScript's CommonJS downlevelling so a real dynamic import
// runs, which Node 24 needs for an ESM-only package required from CJS.
export const importMcpServerModule = new Function(
  'return import("@modelcontextprotocol/sdk/server/mcp.js")',
) as () => Promise<McpServerModule>;

export const importMcpStreamableHttpModule = new Function(
  'return import("@modelcontextprotocol/sdk/server/streamableHttp.js")',
) as () => Promise<McpStreamableHttpModule>;
