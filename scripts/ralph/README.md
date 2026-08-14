# Ralph validation isolation

`approved-issues.json` is the tracked approval ledger for AFK issue prompts. Ralph
requires an exact title/body match before it starts Codex; a GitHub edit therefore
stops the run until a trusted maintainer reviews and updates the snapshot.

Ralph only implements product work. `.agents/**`, `scripts/ralph/**`, and every
`AGENTS.md` are manual control-plane paths: milestone reviews do not create issues
for them, queued infrastructure issues are ignored, and the executor rejects them.

Before any npm preflight or validation script, Ralph builds
`Dockerfile.validation`. Each script runs in a fresh, unprivileged container with
no network, no Docker socket, a read-only image, and a bind mount containing only
tracked or non-ignored workspace files. The container starts an ephemeral local
PostgreSQL instance and uses `.env.example`, so host `.env` secrets and host
credential helpers are never available to generated scripts.

The dependency image generates Prisma Client while network access is available
and then proves that client regeneration and migrations succeed with networking
disabled. Runtime validations mount the reviewed source snapshot, reuse that
pinned client and Linux engine, and build both workspaces without downloading
binaries from mutable product scripts.
