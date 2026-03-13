# Current Work

## Active focus

Leaner MVP package structure and first real vertical slice for the Telegram-first MVP.
Current implementation step: build planner-owned persistence on top of the now-durable Telegram ingress path by turning persisted `inbox_items` into validated `tasks` and auditable `planner_runs`.

## Near-term milestones

- Wire the Next.js app to the simplified workspace packages.
- Define the first Drizzle schema and repository interfaces.
- Implement Telegram webhook ingestion with idempotent bot events.
- Add core planning contract schemas and basic scheduling input/output types.
- Build the minimal internal admin views for inspection and debugging.

## Handoff notes

- The repo is intentionally workspace-ready but lean for MVP: `core`, `db`, and `integrations` are the only packages.
- Google Calendar is a future adapter only; do not build sync logic yet.
- MVP scope is locked in `docs/product/mvp-requirements.md`.
- Keep route handlers thin and push product logic into packages.
- Telegram webhook ingress is now real at the route/service level: secret verification, Telegram payload validation, message normalization, and ingress idempotency are implemented and tested.
- The persistence path on the active feature branch now writes first-seen Telegram ingress to Drizzle-backed `bot_events` and canonical `inbox_items`, with in-memory storage kept for tests only.
- MVP persistence should store Telegram user IDs directly as text across user-linked records; a general internal UUID user model is future work for multi-surface identity.
- The immediate backend milestone is replacing the `processInboxItem` stub with planner-owned persistence that reads canonical `inbox_items`, creates validated `tasks`, and records `planner_runs` as operational audit state.
- After the persistence path is real, the next operational milestone is deploying the existing route on Vercel and registering it with Telegram for a real smoke test.
- Deferred Vercel prep from the earlier branch split is backed up locally in `/tmp/atlas-vercel-prep` as `tracked.patch`, `vercel-telegram-webhook.md`, and `vercel.json`; reapply that work onto a dedicated Vercel branch instead of mixing it into backend feature branches.
- Webhook hardening beyond secret verification and idempotency is future work: keep the secret only in environment-managed secrets, never log it, and add rate limiting or equivalent abuse controls once the core webhook persistence path is fully wired.

## Next-agent handoff

- Good stop point: Telegram webhook ingress now durably persists first-seen messages into `bot_events` and canonical `inbox_items`, and duplicate deliveries short-circuit without creating duplicate rows.
- The persistence path is implemented in `packages/db` and exercised by a real Postgres integration test in `tests/integration/postgres-ingress-persistence.test.ts`.
- The next product/backend slice is downstream planner persistence: replace the `processInboxItem` stub with code that reads persisted `inbox_items`, creates validated `tasks`, and records `planner_runs` as operational audit state.
- Keep the data-boundary split intact: `bot_events` is operational transport state, `inbox_items` is canonical capture state, and future planner output must not overwrite the meaning of the original inbox record.
- Do not resume the deferred Vercel deployment work on this branch; keep that operational follow-up separate from planner/task persistence.

## inspect-ai-guardrails

- The repo has strong written anti-slop guidance in `AGENTS.md`, `docs/architecture/system-boundaries.md`, and `docs/architecture/component-contracts.md`. During scaffolding, most of that guidance is intentionally documentary rather than mechanically enforced.
- Current posture is acceptable for scaffolding: thin routes, package boundaries, shared schemas in `packages/core`, and working repo-wide `typecheck`, `test`, and `lint`.
- `tests/contracts` is still a placeholder folder for later feature work. `tests/integration` is now wired as a workspace package and currently covers the real Postgres ingress persistence path; expand it as webhook, reminder, and replanning flows become real.
- Structured OpenAI output validation is intentionally stubbed for now. When real extraction work starts, add runtime schema validation around model output and contract tests that exercise that boundary.
- The current tests are mostly smoke tests that protect scaffold shape, not product behavior. Replace or extend them with real behavior tests as webhook, reminder, planning, and replanning flows become real.
- Database constraints and relationships are still to be designed. When the schema solidifies, move core invariants into the database where appropriate instead of relying only on application-layer validation.
- `pnpm lint` is now automation-safe again. `apps/web` uses a real ESLint CLI config, but repo-wide linting is not yet an architectural enforcement layer.
- I did not find a dependency-boundary tool or CI workflow that would stop agents from violating package boundaries automatically. That is not urgent during scaffolding, but it becomes more valuable once feature work spans packages.
- Next guardrail upgrades should happen alongside feature development, starting with wiring contract and integration suites into the default test command when those suites contain real tests.
- Add boundary rules where useful so linting catches more than syntax and type issues.
- Add real contract tests for model-output validation and real integration tests for webhook, reminder, and replanning flows.
- Add database constraints and relationships after the persistence model is intentionally designed.
