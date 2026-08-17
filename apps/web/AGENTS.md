# Web application instructions

- Use the Next.js App Router under `app/`. Prefer Server Components; add
  `'use client'` only for browser state, effects, or event handlers.
- Never expose server secrets; only `NEXT_PUBLIC_` variables may reach the client.
- One place per shared concern: the API base URL, response contracts and error
  shapes live in `lib/api/`, and every read, write and clearing of the browser
  session goes through `lib/auth/session.ts`. Re-declaring either inside a page
  is how this app ended up with five different behaviours on a 401.
- Never import a Nest DTO class into browser code. Share a pure TypeScript
  contract or a generated OpenAPI type instead.
- A route file is a composition shell. Loading, mutation and auth-failure
  handling belong in a hook; rendering belongs in components the shell arranges.
- Renaming or splitting a spec that owns visual snapshots orphans its baselines:
  `snapshotPathTemplate` contains the spec path, and
  `e2e/profile.spec.ts-snapshots/` holds 18 PNGs. Move the directory in the same
  commit, or the next visual run silently compares against nothing.
- For user-visible changes, verify affected interactions, keyboard accessibility,
  and the configured desktop, mobile, and mobile-landscape Playwright projects.
- A Ralph session substitutes `HOME` and `LOCALAPPDATA` but keeps
  `PLAYWRIGHT_BROWSERS_PATH` pointing at the host browser cache, so run the one
  spec you are fixing: `npx playwright test <file> -g "<title>"` from
  `apps/web`. Run that spec, not the suite — the suite belongs to the
  orchestrator. If the launch still reports a missing executable under
  `ms-playwright`, the cache is absent: do not reinstall browsers and do not
  retry, verify by reading the code and by types instead.
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
