# Web application instructions

- Use the Next.js App Router under `app/`. Prefer Server Components; add
  `'use client'` only for browser state, effects, or event handlers.
- Never expose server secrets; only `NEXT_PUBLIC_` variables may reach the client.
- For user-visible changes, verify affected interactions, keyboard accessibility,
  and the configured desktop, mobile, and mobile-landscape Playwright projects.
- A Ralph session runs with a substituted `HOME` and `LOCALAPPDATA`, so it
  usually has no browsers: the launch fails with `Executable doesn't exist at
...\ms-playwright\...`. On that error do not reinstall browsers and do not
  retry — check the change by reading the code and by types, and let the
  orchestrator run E2E. Interactive agents may use Playwright MCP.
- Run focused checks during implementation. Do not reinstall browsers or rerun
  the complete validation suite from an isolated Ralph agent session.
- Never create or update Playwright visual snapshots. A screenshot is only valid
  in the environment that rendered it, and baselines here come from the
  validation image, not from a session's own browser. Ralph's validation set
  runs `playwright test --ignore-snapshots`, so a baseline written by an agent
  is never compared against anything and only misleads the next reader. Write
  the visual test; the operator regenerates baselines with
  `npm run test:e2e:web:visual`.
- Save manual screenshots under the repository-relative `screenshot/` directory;
  keep Playwright snapshots and failure artifacts in their configured locations.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
