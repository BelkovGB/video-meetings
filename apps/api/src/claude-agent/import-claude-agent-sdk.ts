export type ClaudeAgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

// The SDK ships as ESM only and this API compiles to CommonJS. Node 24 bridges
// that on a plain `require`, but jest replaces both `require` and
// `createRequire` with its own CommonJS-only registry and fails on the SDK's
// `import` statements. Building the import through `new Function` hides it from
// the CommonJS downlevelling, so a real dynamic import runs in both places —
// which under jest needs the `--experimental-vm-modules` flag that the api
// `test:e2e` script passes. Node caches the module, so calling this per request
// costs nothing after the first.
//
// That same real, process-wide import also races the rest of the suite under
// jest's `--runInBand`: this call can be in flight for tens of seconds against
// the real API, and if any other e2e file in that same process happens to tear
// its environment down while this one is still awaiting, the call crashes with
// "Jest environment has been torn down" — blaming whichever file's teardown it
// landed on, not the SDK. Neither ordering nor file choice makes this safe, so
// every e2e file that calls into the SDK — directly, or through a caller of
// `importClaudeAgentSdk` — needs its own solo Jest invocation in
// `apps/api/package.json`'s `test:e2e`, not a shared one with the rest of the
// suite.
export const importClaudeAgentSdk = new Function(
  'return import("@anthropic-ai/claude-agent-sdk")',
) as () => Promise<ClaudeAgentSdk>;
