# Data Model Boundaries

## Purpose

This document defines which records in Atlas are canonical for the MVP, which are operational or derived, and which existing schema elements are intentionally deferred.

Use it to keep webhook, schema, repository, and planner work aligned on one question: what kind of truth does each record represent?

## Boundary categories

- Canonical records: product state the app owns as the source of truth
- Operational records: transport, idempotency, retry, or audit records that support the system but do not define product state
- Derived records: records or fields computed from canonical state or model output
- External-reference records: identifiers that point at outside systems but do not replace Atlas-owned state
- Deferred records: schema elements present in the repo but not active MVP truth yet

## MVP-canonical records

### `inbox_items`

- Classification: canonical record
- Represents: the persisted captured brain dump or conversational scheduling input after ingress normalization
- Source of truth for: what Atlas accepted from the user for downstream processing and later conversational resolution
- Created by: ingress flow after Telegram validation and before planner extraction mutates downstream task state
- Allowed mutations: processing status and links to created task records
- Must not be confused with: raw Telegram payload history, extracted tasks, or planner output

Notes:
- `raw_text` preserves the accepted user content.
- `normalized_text` preserves the app-normalized form used for downstream processing.
- `inbox_items` should exist before extraction creates tasks or schedule mutations.
- `inbox_items` are capture truth, not the long-term source of truth for schedule state themselves.

### `tasks`

- Classification: canonical record
- Represents: the MVP normalized work item extracted from an inbox item
- Source of truth for: current task state, current accountability state, and the current scheduled commitment snapshot in the MVP
- Created by: planner or extraction flow after validation of app-owned schemas
- Allowed mutations: lifecycle state, current external-calendar commitment snapshot, follow-up metadata, and other task-level metadata owned by the application
- Must not be confused with: the original inbox text, reminder deliveries, or future subtasks

Notes:
- In MVP, `tasks` are the active schedulable work abstraction.
- The model may suggest task structure, but Atlas owns the persisted task record.
- `tasks` should hold the live lifecycle field, source and last-touch inbox provenance, task-level `reschedule_count`, and the current external-calendar-backed commitment snapshot.
- The current commitment snapshot on `tasks` is `external_calendar_event_id`, `external_calendar_id`, `scheduled_start_at`, and `scheduled_end_at`.
- `awaiting_followup` is not entered at scheduling time. It should be entered only after the scheduled block has ended and Atlas has requested follow-up from the user.
- `tasks` are the default read model for active work. Basic product queries should not need to reconstruct current state from history.

### `schedule_blocks`

- Classification: deferred/transitional record
- Represents: legacy internal schedule proposals and transitional planner-facing schedule aliases
- Source of truth for: not active runtime truth
- Created by: earlier scheduler logic and transitional migration paths
- Allowed mutations: not relevant to the lean external-calendar-backed task model
- Must not be confused with: Telegram reminders, calendar events, or a task itself

Notes:
- `schedule_blocks` are no longer the active persisted scheduling record for runtime reads and writes.
- External calendar ids on the task row are references to the canonical scheduled-time system; Atlas still owns task identity and accountability state.
- `schedule_blocks` should not become the active scheduling unit again while the lean task-centric model is in place.

### `user_profiles`

- Classification: canonical record
- Represents: persisted user scheduling preferences and reminder preferences
- Source of truth for: user-level defaults used by scheduling and reminders
- Created by: app-owned settings flows or seed/setup flows
- Allowed mutations: profile preferences owned by the app
- Must not be confused with: planner output or ephemeral per-request context

Notes:
- For MVP, only the subset needed for simple scheduling and reminders should be treated as active truth.
- Richer fields may exist before the corresponding behavior is fully active.

## Operational records

### `bot_events`

- Classification: operational record
- Represents: inbound or outbound bot transport events plus idempotency context
- Source of truth for: webhook deduplication, delivery bookkeeping, and retry-safe transport history
- Created by: Telegram ingress and future outbound delivery flows
- Allowed mutations: retry-state or delivery-state style operational updates
- Must not be confused with: inbox capture state, task state, or schedule state

Notes:
- `bot_events` support transport reliability.
- They are not the user-facing product memory.

### `planner_runs`

- Classification: operational record
- Represents: an auditable record of a planner or extraction pass
- Source of truth for: traceability of model input/output and planner versioning
- Created by: planner execution
- Allowed mutations: none beyond planner-owned write-once or append-only style audit usage
- Must not be confused with: current task state, inbox truth, or current schedule truth

Notes:
- If planner output changes later, the current canonical state still lives in `tasks`, not in `planner_runs`.
- `planner_runs` may act as an operational anchor for conversational scheduling resolution, but they do not replace canonical task or schedule ownership.

## Deferred or non-canonical-for-MVP records

### `task_actions`

- Classification: deferred record
- Represents: future subtask or next-action level scheduling units
- Source of truth for: not active MVP truth
- Created by: future breakdown flows, not required for the locked MVP
- Allowed mutations: not relevant to MVP planning decisions yet
- Must not be confused with: the active MVP task model

Notes:
- This table exists in the schema, but adaptive breakdown is explicitly deferred beyond MVP.
- Agents should not treat the existence of `task_actions` as permission to make action-level scheduling the active MVP model.

## Derived and external-reference fields

- `normalized_text` on `inbox_items` is derived from accepted user input and remains part of canonical inbox state once persisted.
- `linked_task_ids` on `inbox_items` is derived linkage, not the task source of truth itself.
- `confidence` fields are derived metadata and must not outrank canonical task state.
- `external_calendar_event_id` and `external_calendar_id` on `tasks` are external-reference fields pointing at the canonical scheduled-time system.
- `scheduled_start_at`, `scheduled_end_at`, and task-level lifecycle timestamps on `tasks` are canonical task state, not derived convenience copies.
- Planner-selected intent type or ambiguity state is derived processing metadata, not the canonical meaning of a persisted task or block.

## Webhook-first rules

- A Telegram update is transport input, not canonical product state by itself.
- Ingress should persist operational transport state in `bot_events`.
- Ingress should persist canonical capture state in `inbox_items` before extraction creates or mutates downstream task state.
- Planner output may create or update `tasks`, but it must not overwrite the meaning of the original `inbox_items`.
- Scheduler output and calendar sync should update the task row's current commitment snapshot directly.
- Conversational schedule moves should resolve against persisted Atlas state instead of treating Telegram history as the scheduler's source of truth.

## Current schema vs MVP truth

- Atlas may contain schema elements and types that are ahead of the locked MVP.
- Existence in the schema does not automatically make a record part of active MVP truth.
- When implementation and MVP boundaries diverge, agents should follow the MVP-canonical model in this document unless the product scope is intentionally changed.
- If a data ownership change is intentional, update this doc alongside the code instead of letting the boundary drift silently.

## Current convergence note

- The architecture docs define `inbox_items` as canonical capture state for MVP.
- If a code path currently records `bot_events` before `inbox_items` exist durably, treat that as an implementation gap to close, not as a change to the ownership model.
