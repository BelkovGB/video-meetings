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

## Local PostgreSQL

Copy `.env.example` to `.env` and set a local password, then start the database:

```bash
npm run db:up
```

PostgreSQL is available at `localhost:5432` with the credentials in `.env`.
Its data is stored in the Docker volume `postgres_data`. Use `npm run db:logs`
to follow container logs and `npm run db:down` to stop it.

The API also reads `DATABASE_URL` and `JWT_SECRET` from the same `.env` file.

## API documentation

- [HTTP API contract](docs/api.md) — authentication, request payloads, response
  shapes, validation rules, and status codes.
- [API architecture](docs/api-architecture.md) — Nest modules, the CQRS flow,
  data ownership, and database migrations.

## API end-to-end tests

End-to-end tests require the local PostgreSQL instance configured through `.env`.
Start it before running the tests:

```bash
npm run db:up
```

Then run all API end-to-end tests from the repository root:

```bash
npm run test:e2e --workspace @video-meetings/api
```

The suite covers authentication and protected meeting operations. Stop the
database afterwards when it is no longer needed:

```bash
npm run db:down
```

## Database schema

Prisma schema and migrations belong to `apps/api/prisma`. After changing the
schema, create and apply a migration:

```bash
npm run prisma:migrate --workspace @video-meetings/api -- --name describe-your-change
```

## Git hooks

The project-managed Husky pre-commit hook formats staged source and
configuration files with Prettier, runs workspace linting, and runs the API
end-to-end test suite. Ensure PostgreSQL is running (`npm run db:up`) before
committing. The hook is enabled automatically by `npm install` in a Git
repository.
