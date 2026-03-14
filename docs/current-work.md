# Current Work

## Active focus

Schedule-forward inbox processing for the Telegram-first MVP is at a good checkpoint.
Current implementation step: tighten outbound Telegram follow-up reliability, improve clarification UX, and continue hardening schedule-forward conversational processing over persisted Atlas state.

## Near-term milestones

- Thread clarification handling through persisted inbox, planner-run, task, and schedule state so reply messages can resume processing safely.
- Back the admin inbox, planner-runs, and schedule pages with real repository data.
- Tighten planner prompt quality and post-planning scheduling rules for harder mixed or conditional requests while keeping behavior explainable.
- Expand Postgres integration coverage for ambiguous scheduling cases, clarification flows, and more model-output edge cases.

## Handoff notes

- Webhook ingress is idempotent and persists canonical `inbox_items` before any planner mutation.
- `apps/web` now owns the orchestration service for inbox processing; `packages/core` owns planning schemas, alias resolution, and deterministic scheduling helpers; `packages/integrations` owns the Responses API call; `packages/db` owns persistence for inbox-processing context and commits.
- The current MVP is intentionally schedule-forward: plain task capture attempts immediate scheduling instead of building an unscheduled backlog by default.
- Conversational scheduling must resolve from persisted Atlas state. Do not rely on broad recent Telegram history as memory.
- `schedule_blocks` now attach directly to canonical `tasks` for MVP scheduling. `task_actions` remain deferred and should not become the active scheduling unit.
- `planner_runs` are the operational audit trail for inbox processing and the sole persisted source of planner confidence. `inbox_items` no longer store planner confidence.
- The webhook no longer seeds test-only in-memory processing state. Tests must inject in-memory stores and explicit priming when they want to exercise the handler without Postgres.
- The webhook now attempts outbound Telegram follow-up delivery for planner outcomes, retries once inline on transport failure, and records outgoing transport events in `bot_events`.
- The app now clarifies instead of applying unsafe planner outputs for:
  - `clarify` mixed with mutating actions
  - unsupported mixes of move and create actions
  - unresolved symbolic aliases
  - duplicate schedule actions for the same existing task
- Full verification for this checkpoint:
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test`
  - local Postgres integration suite passing outside the sandbox against `apps/web/.env.test.local`
- Highest-value next pass is product polish rather than architecture:
  - improve outbound Telegram delivery reliability and error observability
  - resume clarification flows from persisted Atlas state rather than Telegram history
  - cover outbound reply delivery and clarification loops with integration tests
  - improve prompt behavior for mixed new/existing work
  - improve handling of conditional requests

## Inspect AI Guardrails

- Keep route handlers thin. New behavior should land in app-layer services, `packages/core`, or `packages/db`, not directly in Next.js routes.
- Extend the existing core and repository modules before creating new abstractions. Avoid catch-all helpers or conversation-memory utilities.
- Keep conversational awareness grounded in persisted tasks, schedule blocks, user profiles, and planner runs. Telegram transcripts are not a source of truth.
- Validate structured planner output at the boundary before any task or schedule mutation, and keep model references symbolic rather than id-based.
- When adding scheduling behavior, preserve the MVP promise: deterministic, explainable, and auditable over clever but opaque autonomy.
