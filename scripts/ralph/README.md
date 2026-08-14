# Ralph validation isolation

`approved-issues.json` is the tracked approval ledger for AFK issue prompts. Ralph
requires an exact title/body match before it starts Codex; a GitHub edit therefore
stops the run until a trusted maintainer reviews and updates the snapshot.

Before any npm preflight or validation script, Ralph builds
`Dockerfile.validation`. Each script runs in a fresh, unprivileged container with
no network, no Docker socket, a read-only image, and a bind mount containing only
tracked or non-ignored workspace files. The container starts an ephemeral local
PostgreSQL instance and uses `.env.example`, so host `.env` secrets and host
credential helpers are never available to generated scripts.
