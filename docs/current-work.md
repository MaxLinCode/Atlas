# Current Work

## Active focus

Leaner MVP package structure and first real vertical slice for the Telegram-first MVP.
Current implementation step: replace the `processInboxItem` stub with planner-owned persistence that reads canonical `inbox_items`, creates validated `tasks`, and records `planner_runs` as operational audit state.

## Near-term milestones

- Replace the `processInboxItem` stub with planner-owned persistence over canonical `inbox_items`.
- Persist validated planner output into `tasks` and `planner_runs`.
- Add task and planner-run repository APIs alongside the existing ingress store.
- Validate planner model input and output at the persistence boundary.
- Flesh out the existing internal admin views with real inspection data.

## Handoff notes

- The repo is intentionally workspace-ready but lean for MVP: `core`, `db`, and `integrations` are the only packages.
- Google Calendar is a future adapter only; do not build sync logic yet.
- MVP scope is locked in `docs/product/mvp-requirements.md`.
- Keep route handlers thin and push product logic into packages.
- Telegram webhook ingress is now real at the route/service level: secret verification, Telegram payload validation, message normalization, and ingress idempotency are implemented and tested.
- The persistence path on the active feature branch now writes first-seen Telegram ingress to Drizzle-backed `bot_events` and canonical `inbox_items`, with in-memory storage kept for tests only.
- The Next.js app is already wired to the simplified workspace packages for webhook, planner, and admin-surface scaffolding.
- The initial Drizzle schema and migrations already exist for `bot_events`, `inbox_items`, `tasks`, and `planner_runs`.
- MVP persistence should store Telegram user IDs directly as text across user-linked records; a general internal UUID user model is future work for multi-surface identity.
- The Vercel deployment milestone is complete: the production webhook route is live, Telegram `setWebhook` is registered against the deployed HTTPS endpoint, and a real smoke test succeeded.
- Live duplicate-delivery behavior has also been smoke-tested against production webhook ingress and correctly short-circuits on repeated `update_id` values.
- The next backend milestone is replacing the `processInboxItem` stub with planner-owned persistence that reads canonical `inbox_items`, creates validated `tasks`, and records `planner_runs` as operational audit state.
- Core planning and scheduling schemas already live in `packages/core`; the remaining work is using them at the planner boundary with runtime validation and persistence.
- Minimal internal admin pages already exist for inbox, planner runs, schedule, and settings, but they are still placeholder inspection surfaces rather than data-backed tools.
- End-to-end deployability still needs hardening after the webhook milestone: add a hosted migration-apply workflow, clarify migration command behavior, and document a repeatable production deploy-and-verify sequence.
- Webhook hardening beyond secret verification and idempotency is future work: keep the secret only in environment-managed secrets, never log it, and add rate limiting or equivalent abuse controls once the core webhook persistence path is fully wired.

## Next-agent handoff

- Good stop point: Telegram webhook ingress now durably persists first-seen messages into `bot_events` and canonical `inbox_items`, and duplicate deliveries short-circuit without creating duplicate rows.
- The persistence path is implemented in `packages/db` and exercised by a real Postgres integration test in `tests/integration/postgres-ingress-persistence.test.ts`.
- Vercel deployment and live Telegram webhook smoke testing are complete, including successful webhook registration and a duplicate-delivery smoke test against the deployed route.
- The active product/backend slice is now downstream planner persistence: replace the `processInboxItem` stub with code that reads persisted `inbox_items`, creates validated `tasks`, and records `planner_runs` as operational audit state.
- Keep the data-boundary split intact: `bot_events` is operational transport state, `inbox_items` is canonical capture state, and future planner output must not overwrite the meaning of the original inbox record.
- Use real Postgres credentials in deployed environments; placeholder `localhost` connection strings will fail on Vercel.
- Current deployment setup still requires manual schema application against hosted Postgres. Follow-up work should add an explicit migration-apply workflow for hosted environments, rename or replace the misleading `pnpm db:migrate` generate-only command, and document a safer deploy sequence so Vercel smoke tests do not depend on manual `psql` steps.
- After planner persistence starts moving, keep end-to-end deployability visible as a parallel operational follow-up so production deploys become repeatable without relying on chat history or manual memory.

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
