export type McpServerModule = typeof import('@modelcontextprotocol/sdk/server/mcp.js');
export type McpStdioModule = typeof import('@modelcontextprotocol/sdk/server/stdio.js');

// Same problem and same fix as `importClaudeAgentSdk`: @modelcontextprotocol/sdk
// ships ESM-only and this app compiles to CommonJS. `new Function` hides the
// import from TypeScript's CommonJS downlevelling so a real dynamic import
// runs, which Node 24 needs for an ESM-only package required from CJS.
export const importMcpServerModule = new Function(
  'return import("@modelcontextprotocol/sdk/server/mcp.js")',
) as () => Promise<McpServerModule>;

export const importMcpStdioModule = new Function(
  'return import("@modelcontextprotocol/sdk/server/stdio.js")',
) as () => Promise<McpStdioModule>;
