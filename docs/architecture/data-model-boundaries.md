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
- Represents: the persisted captured brain dump after ingress normalization
- Source of truth for: what Atlas accepted from the user for downstream processing
- Created by: ingress flow after Telegram validation and before planner extraction mutates downstream task state
- Allowed mutations: processing status, planner confidence, and links to created task records
- Must not be confused with: raw Telegram payload history, extracted tasks, or planner output

Notes:
- `raw_text` preserves the accepted user content.
- `normalized_text` preserves the app-normalized form used for downstream processing.
- `inbox_items` should exist before extraction creates tasks.

### `tasks`

- Classification: canonical record
- Represents: the MVP normalized work item extracted from an inbox item
- Source of truth for: current task state in the MVP
- Created by: planner or extraction flow after validation of app-owned schemas
- Allowed mutations: task status and task-level metadata owned by the application
- Must not be confused with: the original inbox text, reminder deliveries, or future subtasks

Notes:
- In MVP, `tasks` are the active schedulable work abstraction.
- The model may suggest task structure, but Atlas owns the persisted task record.

### `schedule_blocks`

- Classification: canonical record
- Represents: the internal planned-time assignment for MVP scheduling
- Source of truth for: the current Atlas-managed schedule
- Created by: scheduler logic using canonical tasks plus user profile settings
- Allowed mutations: start/end time, confidence, and scheduler-owned lifecycle fields
- Must not be confused with: Telegram reminders, calendar events, or a task itself

Notes:
- `schedule_blocks` are Atlas-owned even if future calendar sync is added.
- External calendar ids are references, not primary schedule ownership.

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
- If planner output changes later, the current canonical state still lives in `tasks` and `schedule_blocks`, not in `planner_runs`.

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
- `confidence` fields are derived metadata and must not outrank canonical state.
- `external_calendar_id` on `schedule_blocks` is an external-reference field for future integrations and does not move schedule ownership out of Atlas.

## Webhook-first rules

- A Telegram update is transport input, not canonical product state by itself.
- Ingress should persist operational transport state in `bot_events`.
- Ingress should persist canonical capture state in `inbox_items` before extraction creates or mutates downstream task state.
- Planner output may create or update `tasks`, but it must not overwrite the meaning of the original `inbox_items`.
- Scheduler output may create or update `schedule_blocks`, but it must not redefine task meaning.

## Current schema vs MVP truth

- Atlas may contain schema elements and types that are ahead of the locked MVP.
- Existence in the schema does not automatically make a record part of active MVP truth.
- When implementation and MVP boundaries diverge, agents should follow the MVP-canonical model in this document unless the product scope is intentionally changed.
- If a data ownership change is intentional, update this doc alongside the code instead of letting the boundary drift silently.

## Current convergence note

- The architecture docs define `inbox_items` as canonical capture state for MVP.
- If a code path currently records `bot_events` before `inbox_items` exist durably, treat that as an implementation gap to close, not as a change to the ownership model.
