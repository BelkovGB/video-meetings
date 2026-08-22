# API application instructions

- Organize features as Nest modules with thin controllers and injected services.
- Read configuration from environment variables and never commit secrets.
- A service owns one workflow. Splitting further yields files that are always
  read together; not splitting yields the class that owns reads, writes,
  storage, response mapping and compensation at once.
- Path containment for stored files is security-critical: it lives in one
  module with its own tests. Do not re-implement it per adapter, and do not
  introduce a shared base storage class — meeting files and avatars have
  different lifecycle rules.
- A new E2E spec is collected only when its filename matches `.e2e-spec.ts$`.
  That is what makes a shared harness under `test/support/` safe to add.
- Do not share a validator between callers with different rules. `validateEmail`
  is identical on both sides and is shared; `validatePassword` is not — login
  accepts any non-empty value while registration requires at least 9 code points
  and at most 72 bytes, so sharing it either locks out existing users or weakens
  registration.
- `test:e2e` runs `claude-agent.e2e-spec.ts` and `meeting-summary.e2e-spec.ts`
  each alone in their own Jest invocation before the rest of the suite. Both
  call the real Claude Agent SDK, and that real, tens-of-seconds-long call
  races any other e2e file's teardown in the same `--runInBand` process — see
  the comment on `importClaudeAgentSdk` in `claude-agent.service.ts`. A third
  real-SDK e2e file needs its own solo invocation too, not a shared one.
