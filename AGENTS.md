# Project instructions

## Structure

- `apps/web` is the Next.js web application.
- `apps/api` is the NestJS API.
- Use npm workspaces and run shared commands from the repository root.

## Meeting file uploads

- Read [`docs/research-meetings-upload.md`](docs/research-meetings-upload.md)
  before implementing or changing meeting file uploads. It documents the
  recommended architecture, security controls, and evolution path for meeting
  file storage and transfer.

## Commands

- Install: `npm ci`
- Develop both apps: `npm run dev`
- Validate formatting: `npm run format:check`
- Lint: `npm run lint`
- Build: `npm run build`

## Conventions

- Write new application code in TypeScript.
- Keep formatting compatible with Prettier and linting compatible with the root ESLint config.
- Do not add a dependency unless it is needed for the requested work.
- Keep web and API concerns in their respective workspaces.
- When changing the project architecture, update the relevant documentation in the same change.
- For every UI change, use the `ui-ux-pro-max` skill and visually test the changed interface through Playwright MCP before delivery. Verify the affected interactions and responsive behaviour, not only the code or build output. A UI task is complete only after these checks pass.
