# Project instructions

- Monorepo: `apps/web` is Next.js and `apps/api` is NestJS. Run npm workspace
  commands from the repository root.
- Before changing any part of the meeting-file storage lifecycle, read
  `docs/research-meetings-upload.md`.
- Shared validation: `npm run format:check`, `npm run lint`, and `npm run build`.
  Tests: `npm run test:e2e:api`, `npm run test:e2e:web`, and `npm run test:ralph`.
- Update relevant documentation when changing architecture or public contracts.
- Ralph AFK sessions receive their full contract inside the prompt and must not
  read `.agents/RALPH.md`, which is operator documentation. The orchestrator owns
  complete validation runs.

## Token efficiency

- Start with compact output and expand it only when needed to diagnose a failure.
- Use `git status --short`, `git diff --unified=0`, and `git log --oneline -10`.
- Request only needed GitHub fields, for example
  `gh issue list --limit 100 --json number,title`.
- Suppress npm wrapper noise with `npm run --silent <script>`.
- For TypeScript diagnostics, use `npx tsc --noEmit --pretty false` and initially
  show only the last five lines. Preserve the compiler exit code when piping;
  use `Select-Object -Last 5` in PowerShell and `tail -5` with `pipefail` in POSIX.
- Prefer `rg` and targeted file ranges. Do not dump complete logs, generated
  files, lockfiles, or large JSON documents when a focused query is sufficient.

## Writing instructions and documentation

- Prioritise by size times read frequency. A line in every issue prompt costs
  more than a page read once a month.
- Duplicate a short fact; link to a long one. A link costs a step plus the whole
  target file.
- Write what to do. Write why only where a rule looks redundant and would be
  optimised away: security boundaries, deliberate duplication, arbitrary-looking
  limits. A prohibition without a reason gets removed.
- Documentation describing code behaviour needs a test or it starts lying. A
  wrong instruction costs more than a missing one.
- Name the exact path, or the command that finds it. Guessing costs steps.
- Put module instructions in an `AGENTS.md` beside the module, not in a shared
  file, and do not repeat the parent. A new one changes Ralph's trusted set, so
  add it between runs.
