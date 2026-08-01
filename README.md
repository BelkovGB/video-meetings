# Video Meetings

Monorepo for the Video Meetings web client and API.

## Applications

- `apps/web` — Next.js web application, available at http://localhost:3000.
- `apps/api` — NestJS API, available at http://localhost:3001.

## Commands

```bash
npm install
npm run dev
npm run build
npm run lint
npm run format:check
```

Start one application with `npm run dev --workspace @video-meetings/web` or
`npm run dev --workspace @video-meetings/api`.

## Git hooks

The project-managed Husky pre-commit hook formats staged source and
configuration files with Prettier. It is enabled automatically by `npm install`
in a Git repository.
