# Current Work

## Active focus

Atlas is a conversation-first, schedule-forward product with a working mutation pipeline.
Current implementation focus: keep `tasks` as the canonical live-state model with external-calendar-backed current commitments, and use the next pass to design the missing follow-up/runtime lifecycle around that lean task model.

## Near-term milestones

- Finish stabilizing the architecture docs around conversation-first, schedule-forward behavior.
- Tighten outbound Telegram delivery reliability and error observability.
- Thread clarification handling through persisted inbox, planner-run, task, and schedule state so reply messages can resume processing safely.
- Back the admin inbox, planner-runs, and schedule pages with real repository data.
- Define the next data model around task-centric current commitment plus future task history.
- Define runtime behavior for scheduling, follow-up, completion, archive, and reschedule loops.
- Design the dedicated commitment/history model that eventually replaces planner-facing `schedule_block` aliases.
- Expand Postgres integration coverage for ambiguous scheduling cases, clarification flows, and outbound reply loops.
- Preserve safe scheduling and rescheduling over explicit state boundaries in mutation mode.

## Handoff notes

- Atlas should be a planning assistant first and a mutation engine second.
- Schedule-forward remains a core product opinion: when work becomes actionable, Atlas should bias toward proposing or placing time on the schedule.
- The emerging direction is external-calendar-backed scheduling with Atlas retaining task and accountability ownership.
- Every Atlas task should seek scheduled time immediately; unscheduled backlog should not be the default operating model.
- Every scheduled task should receive follow-up after the scheduled block ends, and `awaiting_followup` is now a key lifecycle concept.
- `awaiting_followup` should begin only after the scheduled block has ended and Atlas has issued a follow-up nudge for that task. The runtime path that detects block end and sends that nudge is still intentionally pending design.
- The current branch landed the lean external-calendar-backed task model:
  - live scheduled commitment is now stored directly on `tasks`
  - `schedule_blocks` are no longer the active persisted runtime schedule record
  - planner-facing `schedule_block_*` aliases are reconstructed from task state for compatibility
- Webhook ingress is idempotent and persists canonical `inbox_items` before any planner mutation.
- `apps/web` should own orchestration for both conversation mode and mutation mode; `packages/core` should keep schemas and deterministic scheduling helpers for mutation mode; `packages/integrations` should own model and Telegram transport; `packages/db` should keep canonical persistence and audit state.
- For pure conversation or simple new-capture turns, Atlas likely does not need to load the full task and schedule graph.
- Conversation mode may use recent transcript plus relevant state, but conversational scheduling and existing-work mutations must still resolve from explicit Atlas state. Do not rely on broad recent Telegram history as canonical memory.
- The current runtime now stores live scheduled commitment fields directly on `tasks`: `external_calendar_event_id`, `external_calendar_id`, `scheduled_start_at`, and `scheduled_end_at`.
- `schedule_blocks` no longer act as the active persisted scheduling record for runtime reads and writes. They remain a transitional artifact in the repo and planner vocabulary while the dedicated commitment/history design is still deferred.
- The task row now owns lifecycle state, current commitment snapshot, task-level `reschedule_count`, follow-up timestamps, and inbox provenance directly.
- `0006_external_calendar_task_fields.sql` now backfills scheduled tasks from the old `current_commitment_id -> schedule_blocks` linkage before dropping the transitional column.
- Inbox processing now treats calendar create/update failures like planner failures:
  - failed planner run is recorded
  - inbox item returns to `received`
  - partial scheduled task state is not persisted
- In-memory and Postgres processing stores now return equivalent write-time `scheduleBlocks` payloads, including planner-provided `reason` and `confidence`.
- `planner_runs` should remain an operational audit trail, but they do not need to become the main product memory layer.
- Symbolic aliases are still important for existing-item mutations, but they are likely unnecessary overhead for simple new-task capture.
- The webhook no longer seeds test-only in-memory processing state. Tests must inject in-memory stores and explicit priming when they want to exercise the handler without Postgres.
- The webhook now attempts outbound Telegram follow-up delivery for planner outcomes, retries once inline on transport failure, and records outgoing transport events in `bot_events`.
- The app now clarifies instead of applying unsafe planner outputs for:
  - `clarify` mixed with mutating actions
  - unsupported mixes of move and create actions
  - unresolved symbolic aliases
  - duplicate schedule actions for the same existing task
- Verification completed on this branch:
  - `pnpm --filter @atlas/core typecheck`
  - `pnpm --filter @atlas/db typecheck`
  - `pnpm --filter @atlas/web typecheck`
  - `pnpm --filter @atlas/integration-tests typecheck`
  - `pnpm --filter @atlas/core test`
  - `pnpm --filter @atlas/db test`
  - `pnpm --filter @atlas/web test`
  - `pnpm --filter @atlas/integrations test`
  - `pnpm --filter @atlas/integration-tests test`
- Best next topics after this branch:
  - design the runtime that moves `scheduled -> awaiting_followup` after block end plus follow-up nudge
  - design follow-up outcome handling for `done`, `rescheduled`, `archived`, and still waiting
  - design the dedicated commitment/history model that replaces transitional `schedule_block` planner references

## Inspect AI Guardrails

- Keep route handlers thin. New behavior should land in app-layer services, `packages/core`, or `packages/db`, not directly in Next.js routes.
- Extend the existing core and repository modules before creating new abstractions. Avoid catch-all helpers or conversation-memory utilities.
- Keep conversational awareness grounded in persisted tasks, user profiles, planner runs, and explicit schedule linkage. Telegram transcripts are not a source of truth for mutations.
- Validate structured mutation output at the boundary before any task or schedule mutation, and keep model references explicit rather than id-guessing.
- When adding scheduling behavior, preserve the MVP promise: conversationally helpful, schedule-forward, and safe at the mutation boundary.
