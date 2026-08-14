# Web application instructions

This workspace is a Next.js App Router application.

- Put routes and route-level UI in `app/`.
- Prefer Server Components; add `'use client'` only when browser state, effects, or event handlers are required.
- Keep metadata in `app/layout.tsx` or the relevant route.
- Use the workspace commands: `npm run dev --workspace @video-meetings/web`, `npm run lint --workspace @video-meetings/web`, and `npm run build --workspace @video-meetings/web`.
- Do not access API secrets from browser code; only variables prefixed with `NEXT_PUBLIC_` may be exposed to the client.
- All screenshots save to /screenshot folder

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
