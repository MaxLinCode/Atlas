# Current Work

## Active focus

Leaner MVP package structure and first real vertical slice for the Telegram-first MVP.

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

## inspect-ai-guardrails

- The repo has strong written anti-slop guidance in `AGENTS.md`, `docs/architecture/system-boundaries.md`, and `docs/architecture/component-contracts.md`. During scaffolding, most of that guidance is intentionally documentary rather than mechanically enforced.
- Current posture is acceptable for scaffolding: thin routes, package boundaries, shared schemas in `packages/core`, and working repo-wide `typecheck`, `test`, and `lint`.
- `tests/contracts` and `tests/integration` are placeholder folders for later feature work. They are not wired into `pnpm test` yet, which is fine for scaffolding but should change once model-output parsing and cross-package behavior land.
- Structured OpenAI output validation is intentionally stubbed for now. When real extraction work starts, add runtime schema validation around model output and contract tests that exercise that boundary.
- The current tests are mostly smoke tests that protect scaffold shape, not product behavior. Replace or extend them with real behavior tests as webhook, reminder, planning, and replanning flows become real.
- Database constraints and relationships are still to be designed. When the schema solidifies, move core invariants into the database where appropriate instead of relying only on application-layer validation.
- `pnpm lint` is now automation-safe again. `apps/web` uses a real ESLint CLI config, but repo-wide linting is not yet an architectural enforcement layer.
- I did not find a dependency-boundary tool or CI workflow that would stop agents from violating package boundaries automatically. That is not urgent during scaffolding, but it becomes more valuable once feature work spans packages.
- Next guardrail upgrades should happen alongside feature development, starting with wiring contract and integration suites into the default test command when those suites contain real tests.
- Add boundary rules where useful so linting catches more than syntax and type issues.
- Add real contract tests for model-output validation and real integration tests for webhook, reminder, and replanning flows.
- Add database constraints and relationships after the persistence model is intentionally designed.
