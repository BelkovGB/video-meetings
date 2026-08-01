# Project instructions

## Structure

- `apps/web` is the Next.js web application.
- `apps/api` is the NestJS API.
- Use npm workspaces and run shared commands from the repository root.

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
