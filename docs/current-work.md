# Current Work

## Active focus

Atlas is a conversation-first, schedule-forward product with a working mutation pipeline.
Current implementation focus: keep `tasks` as the canonical live-state model with external-calendar-backed current commitments, implement the locked follow-up/reschedule runtime on top of that lean task model, and upgrade the conversational bot so the new conversation path is context-aware rather than text-only.

## Near-term milestones

- Tighten outbound Telegram delivery reliability and error observability.
- Thread clarification handling through persisted inbox, planner-run, task, and schedule state so reply messages can resume processing safely.
- Back the admin inbox, planner-runs, and schedule pages with real repository data.
- Define the next data model around task-centric current commitment plus future task history.
- Add the task-level schema and repository support needed for the locked follow-up runtime, including `followup_reminder_sent_at`.
- Implement the background follow-up/reminder dispatch path, turn-boundary drain, and per-user locking against the locked runtime semantics.
- Expand integration coverage for follow-up, reminder, late-reply, and reschedule flows under the locked runtime rules.
- Implement conversational bot behavior in small slices rather than one broad thread:
  - context-aware conversation state selection
  - mutation reply renderer
  - mixed-turn confirmation handling
- Design the dedicated commitment/history model that eventually replaces planner-facing `schedule_block` aliases.
- Expand Postgres integration coverage for ambiguous scheduling cases, clarification flows, and outbound reply loops.
- Preserve safe scheduling and rescheduling over explicit state boundaries in mutation mode.

## Handoff notes

- Atlas should be a planning assistant first and a mutation engine second.
- Schedule-forward remains a core product opinion: when work becomes actionable, Atlas should bias toward proposing or placing time on the schedule.
- The emerging direction is external-calendar-backed scheduling with Atlas retaining task and accountability ownership.
- Every Atlas task should seek scheduled time immediately; unscheduled backlog should not be the default operating model.
- Every scheduled task should receive follow-up after the scheduled block ends, and `awaiting_followup` is now a key lifecycle concept.
- `awaiting_followup` should begin only after the scheduled block has ended and Atlas has issued a follow-up nudge for that task.
- The first follow-up should go out immediately after block end unless Atlas is in the middle of an active conversational turn, in which case it should wait for the turn boundary.
- If the first follow-up goes unanswered, Atlas should send one additional reminder 2 hours later, then leave the task unresolved in `awaiting_followup`.
- If multiple tasks are overdue, Atlas should surface them one by one, oldest unresolved first.
- If an unresolved follow-up exists and the user sends a brand-new request, Atlas should handle the new request first, then circle back to the oldest unresolved follow-up.
- If the user says they did not complete the task, Atlas should not allow passive skipping; it should steer toward rescheduling or archiving.
- The current branch landed the lean external-calendar-backed task model:
  - live scheduled commitment is now stored directly on `tasks`
  - `schedule_blocks` are no longer the active persisted runtime schedule record
  - planner-facing `schedule_block_*` aliases are reconstructed from task state for compatibility
- Webhook ingress is idempotent and persists canonical `inbox_items` before any planner mutation.
- `apps/web` should own orchestration for both conversation mode and mutation mode; `packages/core` should keep schemas and deterministic scheduling helpers for mutation mode; `packages/integrations` should own model and Telegram transport; `packages/db` should keep canonical persistence and audit state.
- For pure conversation or simple new-capture turns, Atlas likely does not need to load the full task and schedule graph.
- Conversation mode may use recent transcript plus relevant state, but conversational scheduling and existing-work mutations must still resolve from explicit Atlas state. Do not rely on broad recent Telegram history as canonical memory.
- The current runtime now stores live scheduled commitment fields directly on `tasks`: `external_calendar_event_id`, `external_calendar_id`, `scheduled_start_at`, and `scheduled_end_at`.
- The lean follow-up seam should stay on the task row, not in transport history:
  - `last_followup_at`: the most recent outbound accountability follow-up Atlas successfully sent for the task
  - `followup_reminder_sent_at`: the timestamp when Atlas sent the one extra reminder for the current unresolved follow-up episode
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
- The core follow-up and reschedule runtime semantics are now locked in docs. Remaining implementation work should follow those contracts rather than reopening the model.
- The conversational model behavior is now documented as a separate two-path architecture. Remaining work should implement that design incrementally instead of trying to ship a full conversational bot in one slice.
- The first `TurnRouter` slice is now landed:
  - routing is app-owned in `apps/web`
  - the router is model-assisted through `packages/integrations`
  - inbound Telegram turns are classified as `conversation`, `mutation`, or `conversation_then_mutation`
  - ingress is still persisted canonically before route selection
  - only `mutation` enters the existing planner/write path
  - `conversation` and `conversation_then_mutation` are explicitly non-writing in this slice
- The turn-router prompt is now stricter about mutation readiness:
  - `mutation` should be reserved for clear, direct, sufficiently specified, write-ready requests
  - partial scheduling asks and other underspecified write intents should bias toward `conversation_then_mutation`
  - a small few-shot example set now reinforces the incomplete-versus-write-ready boundary in the router prompt
- A live local turn-router eval harness is now available:
  - `pnpm eval:turn-router` calls the real OpenAI Responses API against a curated fixture set
  - this is intended for manual prompt verification, not deterministic CI coverage
- A live local conversation-context eval harness is now available:
  - `pnpm eval:conversation-context` calls the real OpenAI Responses API against curated recent-turn continuity fixtures
  - this is intended for manual prompt verification of context use and hedged conversation behavior, not deterministic CI coverage
- `primeProcessingStore` is now effectively mutation-only webhook plumbing. Conversational turns should not seed mutation-processing state.
- The first conversation-response slice is now landed:
  - non-writing routed turns now go through an app-owned `conversation-response` service
  - the conversation service is model-assisted through `packages/integrations`
  - `conversation` now returns a natural-language planning reply instead of temporary fallback copy
  - `conversation_then_mutation` now returns a natural-language discuss-first reply instead of temporary fallback copy
  - the conversation path still does not write task or schedule state
  - the conversation path must not claim that side effects happened
- The main limitation in conversation mode is now context grounding:
  - the conversation path now loads a bounded recent-turn window from persisted Telegram transport records
  - it derives a request-scoped working summary for conversational continuity on each non-writing turn
  - this continuity layer is intentionally non-authoritative and must not be treated as canonical Atlas memory or mutation state
- The conversation response path remains app-owned:
  - `apps/web` assembles ephemeral conversation context for `conversation` and `conversation_then_mutation`
  - `packages/integrations` owns the summary and conversation model calls
  - `packages/db` owns the read model for recent persisted turns
- The next task after this context-aware conversation upgrade is mutation reply rendering so planner/mutation outcomes and conversational turns stop sharing the same simple outbound reply shape.
- Mixed-turn confirmation handling is still deferred after those two slices. `conversation_then_mutation` should remain conversation-first until explicit confirmation flow is implemented.
- Verification completed on this branch:
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm --filter @atlas/integration-tests test`
  - `pnpm eval:conversation-context`
  - `pnpm eval:turn-router`

## Next Handoff

- Next implementation task: build mutation reply rendering as its own app-owned slice.
- Add an app-owned mutation reply service for routed `mutation` turns.
- Keep the scope narrow:
  - preserve the existing planner and persistence behavior
  - map mutation outcomes into clearer user-facing replies
  - keep writes in the mutation path only
  - do not fold mutation rendering into the conversation service
- Add tests that prove:
  - context-aware conversation mode remains non-writing after the new recent-turn and working-summary layer
  - mutation turns now render through the dedicated mutation reply service
  - planner outcomes still persist exactly as before
  - no task or schedule writes happen outside the mutation branch
  - conversational turns still use the non-writing conversation response path
- Reuse the existing outbound Telegram delivery path and ingress persistence.
- Keep router behavior unchanged while landing the mutation reply renderer.
- Add a DB-backed integration test for the webhook conversation branch:
  - persist real ingress through the webhook path
  - route a turn to `conversation` or `conversation_then_mutation`
  - verify outbound reply delivery is attempted
  - verify no `planner_runs`, task writes, or schedule writes occur

### Locked runtime semantics

- `last_followup_at` is task-scoped, not scheduled-occurrence-scoped. It records the most recent outbound follow-up-style message Atlas successfully sent for the task, including the first post-block follow-up and the one extra reminder.
- `followup_reminder_sent_at` is scoped to the current unresolved follow-up episode. It remains `null` until Atlas sends the one extra reminder, is set exactly once for that unresolved episode, and is cleared when the unresolved episode ends through completion, archive, or reschedule to a new future scheduled block.
- A follow-up episode begins when Atlas sends the first post-block follow-up for a task and moves it into `awaiting_followup`.
- First-follow-up eligibility is controlled by lifecycle state, not by `last_followup_at`. A task is eligible when `lifecycle_state = scheduled` and `scheduled_end_at <= now`.
- On successful first follow-up send, Atlas transitions the task to `awaiting_followup` and sets `last_followup_at = sent_at`.
- Reminder eligibility is: `lifecycle_state = awaiting_followup`, `followup_reminder_sent_at IS NULL`, `last_followup_at IS NOT NULL`, and `now >= last_followup_at + 2 hours`.
- On successful reminder send, Atlas updates `last_followup_at = sent_at` and `followup_reminder_sent_at = sent_at`.
- Late replies resolve against the oldest unresolved `awaiting_followup` task unless the user clearly names or describes a different task.
- Clear completion marks the task `done`.
- Clear cancel / no-longer-needed intent marks the task `archived`.
- Clear not-done plus a usable future scheduling signal enters reschedule flow.
- If the user provides a concrete future time that resolves to one deterministic slot, Atlas may apply that reschedule directly.
- If the user provides a non-concrete but schedulable future preference such as a daypart or broad scheduling window, Atlas should inspect availability and propose the earliest fitting concrete slot instead of asking a generic clarification question.
- Atlas should keep a narrow deterministic reschedule path for automatic or directly-applicable mutations.
- That deterministic path may place the target task into the earliest valid slot and may single-step push later Atlas-managed tasks forward, but it may not perform richer rearrangements such as swaps, pull-earlier moves, or broader schedule rewrites.
- Atlas may still generate smarter schedule rearrangement proposals conversationally, but those richer proposals require explicit user confirmation before any mutation is applied.
- The deterministic reschedule proposal should preserve the task's current scheduled duration, search from `max(now, next 15-minute boundary)` in the user's timezone, respect explicit user constraints first, respect configured availability and external calendar busy time, and choose the earliest valid slot within a 7-day horizon.
- Daypart requests should be treated as non-concrete but schedulable preferences using fixed windows: morning `09:00-12:00`, afternoon `12:00-17:00`, evening `17:00-21:00` in the user's timezone.
- If a requested daypart or broad scheduling window cannot fit the task, Atlas should not silently spill into another window. It should explicitly propose the next available concrete slot instead.
- Clear not-done without a usable future scheduling signal keeps the task unresolved and Atlas must steer toward rescheduling or archiving.
- If no fitting slot can be found for a non-concrete but schedulable preference within the search horizon, Atlas should ask for a narrower scheduling constraint.
- Partial progress never counts as completion.
- If the message contains a clearly unrelated new planning request, Atlas should handle the new request first and then circle back to the unresolved follow-up.
- Runtime ownership is split as follows: `apps/web` owns cron and webhook orchestration, `packages/core` owns pure follow-up selectors and deterministic reschedule logic, `packages/db` owns task queries, transactional updates, and per-user locking, and `packages/integrations` owns Telegram and calendar IO.
- Follow-up detection and reminder sending should run in a background cron path that evaluates persisted task state, sends outbound messages, and updates task state only after successful delivery.
- Turn-boundary handling should run once at the end of inbound webhook processing so Atlas can wait until the active conversational turn finishes before sending a newly due follow-up or reminder.
- Follow-up dispatch, inbound webhook processing, and turn-boundary drain must all use the same per-user lock so only one runtime actor evaluates and mutates follow-up state for a given user at a time.
- While holding that per-user lock, the runtime should select the oldest unresolved follow-up candidate for the user, attempt any needed send, and apply the resulting task-state transition before releasing the lock.

## Inspect AI Guardrails

- Keep route handlers thin. New behavior should land in app-layer services, `packages/core`, or `packages/db`, not directly in Next.js routes.
- Extend the existing core and repository modules before creating new abstractions. Avoid catch-all helpers or conversation-memory utilities.
- Keep conversational awareness grounded in persisted tasks, user profiles, planner runs, and explicit schedule linkage. Telegram transcripts are not a source of truth for mutations.
- Validate structured mutation output at the boundary before any task or schedule mutation, and keep model references explicit rather than id-guessing.
- When adding scheduling behavior, preserve the MVP promise: conversationally helpful, schedule-forward, and safe at the mutation boundary.
