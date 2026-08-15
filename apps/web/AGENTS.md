# Web application instructions

- Use the Next.js App Router under `app/`. Prefer Server Components; add
  `'use client'` only for browser state, effects, or event handlers.
- Never expose server secrets; only `NEXT_PUBLIC_` variables may reach the client.
- For user-visible changes, read `.agents/skills/ui-ux-pro-max/SKILL.md` and verify
  affected interactions, keyboard accessibility, and the configured desktop,
  mobile, and mobile-landscape Playwright projects.
- Use the Playwright tooling available in the execution environment. Interactive
  agents may use Playwright MCP; Ralph sessions treat orchestrator validation as
  authoritative.
- Run focused checks during implementation. Do not reinstall browsers or rerun
  the complete validation suite from an isolated Ralph agent session.
- Update visual snapshots only for intentional rendered changes and inspect the
  resulting images before accepting them.
- Save manual screenshots under the repository-relative `screenshot/` directory;
  keep Playwright snapshots and failure artifacts in their configured locations.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
