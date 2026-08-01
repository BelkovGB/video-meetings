# API application instructions

This workspace is a NestJS API.

- Group new functionality into Nest modules with controllers and services.
- Keep controllers thin; place application logic in services.
- Use dependency injection rather than manually creating application services.
- Read configuration from environment variables and do not commit secrets.
- Use the workspace commands: `npm run dev --workspace @video-meetings/api`, `npm run lint --workspace @video-meetings/api`, and `npm run build --workspace @video-meetings/api`.
