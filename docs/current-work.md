# Current Work

## Active focus

Atlas is pivoting toward a conversation-first, schedule-forward product definition.
Current implementation focus: stabilize the architecture docs around that pivot before changing schema or runtime behavior. The next pass should separate conversation mode from mutation mode, define external-calendar-backed scheduling ownership, and simplify state loading for the common conversational path.

## Near-term milestones

- Finish stabilizing the architecture docs around conversation-first, schedule-forward behavior.
- Define the next data model around task-centric current commitment plus task history.
- Define runtime behavior for scheduling, follow-up, completion, archive, and reschedule loops.
- Preserve safe scheduling and rescheduling over explicit state boundaries in mutation mode.

## Handoff notes

- Atlas should be a planning assistant first and a mutation engine second.
- Schedule-forward remains a core product opinion: when work becomes actionable, Atlas should bias toward proposing or placing time on the schedule.
- The emerging direction is external-calendar-backed scheduling with Atlas retaining task and accountability ownership.
- Every Atlas task should seek scheduled time immediately; unscheduled backlog should not be the default operating model.
- Every scheduled task should receive follow-up after the scheduled block ends, and `awaiting_followup` is now a key lifecycle concept.
- Webhook ingress is idempotent and persists canonical `inbox_items` before any planner mutation.
- `apps/web` should own orchestration for both conversation mode and mutation mode; `packages/core` should keep schemas and deterministic scheduling helpers for mutation mode; `packages/integrations` should own model and Telegram transport; `packages/db` should keep canonical persistence and audit state.
- For pure conversation or simple new-capture turns, Atlas likely does not need to load the full task and schedule graph.
- Conversation mode may use recent transcript plus relevant state, but conversational scheduling and existing-work mutations must still resolve from explicit Atlas state. Do not rely on broad recent Telegram history as canonical memory.
- The current `schedule_blocks` model is part of the existing implementation, but the architecture is moving toward task-centric current commitment plus external-calendar-backed scheduling. `task_actions` remain deferred and should not become the active scheduling unit.
- `planner_runs` should remain an operational audit trail, but they do not need to become the main product memory layer.
- Symbolic aliases are still important for existing-item mutations, but they are likely unnecessary overhead for simple new-task capture.

## Inspect AI Guardrails

- Keep route handlers thin. New behavior should land in app-layer services, `packages/core`, or `packages/db`, not directly in Next.js routes.
- Extend the existing core and repository modules before creating new abstractions. Avoid catch-all helpers or conversation-memory utilities.
- Keep conversational awareness grounded in persisted tasks, user profiles, planner runs, and explicit schedule linkage. Telegram transcripts are not a source of truth for mutations.
- Validate structured mutation output at the boundary before any task or schedule mutation, and keep model references explicit rather than id-guessing.
- When adding scheduling behavior, preserve the MVP promise: conversationally helpful, schedule-forward, and safe at the mutation boundary.
