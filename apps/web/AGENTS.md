# Web application instructions

This workspace is a Next.js App Router application.

- Put routes and route-level UI in `app/`.
- Prefer Server Components; add `'use client'` only when browser state, effects, or event handlers are required.
- Keep metadata in `app/layout.tsx` or the relevant route.
- Use the workspace commands: `npm run dev --workspace @video-meetings/web`, `npm run lint --workspace @video-meetings/web`, and `npm run build --workspace @video-meetings/web`.
- Do not access API secrets from browser code; only variables prefixed with `NEXT_PUBLIC_` may be exposed to the client.
