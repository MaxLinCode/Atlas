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
- Created by: ingress flow after transport validation and before planner extraction mutates downstream task state
- Allowed mutations: processing status and links to created task records
- Must not be confused with: raw transport payload history, extracted tasks, or planner output

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
- `calendar_sync_status` and `calendar_sync_updated_at` on `tasks` are Atlas-owned projection health fields. They record whether Atlas currently considers the linked external-calendar snapshot safe to trust as a local read model.
- `awaiting_followup` is not entered at scheduling time. It should be entered only after the scheduled block has ended and Atlas has requested follow-up from the user.
- `last_followup_at` and `followup_reminder_sent_at` belong to task-level product state, not to transport history.
- `last_followup_at` is task-scoped. It records the most recent outbound accountability follow-up Atlas successfully sent for the task and is not cleared on reschedule.
- `followup_reminder_sent_at` tracks whether Atlas has already spent the one extra reminder for the current unresolved follow-up episode. It should reset when that unresolved episode ends through completion, archive, or reschedule to a new future scheduled block.
- `tasks` are the default read model for active work. Basic product queries should not need to reconstruct current state from history.

### `schedule_blocks`

- Classification: deferred/transitional record
- Represents: legacy internal schedule proposals and transitional planner-facing schedule aliases
- Source of truth for: not active runtime truth
- Created by: earlier scheduler logic and transitional migration paths
- Allowed mutations: not relevant to the lean external-calendar-backed task model
- Must not be confused with: bot reminders, calendar events, or a task itself

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

### `google_calendar_accounts`

- Classification: canonical record
- Represents: the Atlas-owned linkage between one Atlas user and one selected writable Google Calendar
- Source of truth for: linked account identity, selected calendar identity, token lifecycle metadata, and sync bookkeeping needed to access Google Calendar on the user's behalf
- Created by: app-owned Google OAuth callback flow after validation and token exchange
- Allowed mutations: selected calendar metadata, token refresh metadata, revocation state, and sync cursor/timestamps owned by the app
- Must not be confused with: scheduled task state or the external calendar event itself

Notes:
- V1 supports one linked Google account and one selected writable calendar per Atlas user.
- This record exists so Atlas can resolve a user-scoped Google Calendar client without re-running OAuth on each request.
- This record does not replace the task row as Atlas's local scheduled-commitment projection.
- Access and refresh tokens are stored as encrypted-at-rest credentials, not as admin-readable metadata.
- Normal read models should expose redacted linkage metadata only; raw credentials should be available only to the runtime path that builds the Google adapter.

### `conversations`

- Classification: canonical record
- Represents: the durable container for one user-scoped conversation thread, including the current broad summary and active interaction mode
- Source of truth for: which conversation snapshot Atlas should use when loading entity registry and discourse state for reference resolution
- Created by: app-owned conversation-state orchestration when a linked user enters the normal chat flow
- Allowed mutations: title, summary text, mode, and updated timestamps owned by the app
- Must not be confused with: raw transport events, planner runs, or the entity registry itself

Notes:
- `summary_text` is a compression aid for long-horizon continuity, not the exact referent-resolution mechanism.
- In the current Telegram-first runtime, Atlas may maintain one latest active conversation per user even though the schema leaves room for multiple conversation rows over time.

### `conversation_entities`

- Classification: canonical record
- Represents: first-class conversation objects such as tasks, proposal options, scheduled blocks, clarifications, and reminders that were created or referenced during the conversation
- Source of truth for: object-level conversational memory and short-horizon reference resolution
- Created by: app-owned conversation-state orchestration after conversation replies, mutation results, clarification prompts, and reminder bundles
- Allowed mutations: status, labels, payload updates, and supersession as the conversation evolves
- Must not be confused with: canonical task state in `tasks` or raw transcript text in `conversation_turns`

Notes:
- This table exists so Atlas can resolve phrases like `it`, `that`, or `the other one` against explicit objects instead of loosely replaying transcript.
- Task and schedule entities here are conversational projections; canonical task lifecycle and commitment state still live in `tasks`.

### `conversation_discourse_states`

- Classification: canonical short-lived working-memory record
- Represents: the current conversational focus, active entity ids, and pending clarification focus for the latest branch of discussion
- Source of truth for: which conversation object Atlas should treat as currently salient when recent user language is referential or elliptical
- Created by: app-owned conversation-state orchestration alongside entity-registry updates
- Allowed mutations: replacement of the current working-memory payload on each turn
- Must not be confused with: the broader summary, full transcript, or durable task/product state

Notes:
- This record is intentionally short-lived and branch-local.
- It should be cheap to replace wholesale as the active focus moves.

## Operational records

### `bot_events`

- Classification: operational record
- Represents: inbound or outbound bot transport events plus idempotency context
- Source of truth for: webhook deduplication, delivery bookkeeping, and retry-safe transport history
- Created by: messaging ingress and future outbound delivery flows
- Allowed mutations: retry-state or delivery-state style operational updates
- Must not be confused with: inbox capture state, task state, or schedule state

Notes:
- `bot_events` support transport reliability.
- They are not the user-facing product memory.
- They should not be the source of truth for whether the one follow-up reminder has already been sent.
- They should have bounded operational retention rather than indefinite history by default.

### `conversation_turns`

- Classification: operational/continuity record
- Represents: the raw user and assistant transcript for audit, replay, debugging, and bounded conversational continuity
- Source of truth for: ordered replay of what was said in the active conversation
- Created by: app-owned conversation-state orchestration after accepted inbound user turns and final outbound assistant replies
- Allowed mutations: append-only in normal operation
- Must not be confused with: the entity registry or discourse-state focus model

Notes:
- Transcript is useful continuity context, but it is not Atlas's exact object memory.
- Reference resolution should prefer `conversation_entities` plus `conversation_discourse_states` over transcript reconstruction when possible.

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
- Because planner runs may contain sensitive planning context, they should have bounded operational retention and should not be broadly exposed in admin/debug tooling.

### `google_calendar_oauth_states`

- Classification: operational record
- Represents: short-lived OAuth state used to safely complete Google account-linking flows
- Source of truth for: replay protection and request correlation during OAuth callback handling
- Created by: app-owned Google OAuth start flow
- Allowed mutations: one-time consumption and expiration handling
- Must not be confused with: long-lived linked account state or task schedule state

Notes:
- OAuth state is operational security machinery, not product memory.
- Consumed or expired state records should not be treated as evidence of an active linked account.
- Retention should be measured in hours, not days.

### `google_calendar_link_handoffs`

- Classification: operational record
- Represents: one-time chat-to-browser handoff records used to begin Google account linking safely
- Source of truth for: replay protection before the app creates a short-lived link session cookie
- Created by: app-owned Google connect-link issuance
- Allowed mutations: one-time consumption and expiration cleanup
- Must not be confused with: a logged-in Atlas session or an active linked account

Notes:
- These records are short-lived and should be purged aggressively after use or expiry.

### `google_calendar_link_sessions`

- Classification: operational record
- Represents: short-lived server-side sessions used only to complete the Google OAuth handoff flow
- Source of truth for: which Atlas user is allowed to start OAuth during the current link attempt
- Created by: the app-owned `/google-calendar/connect` handoff route after validating a one-time link token
- Allowed mutations: one-time consumption and expiration cleanup
- Must not be confused with: durable user auth or long-lived Atlas account sessions

Notes:
- Link sessions are intentionally narrow and short-lived.
- They exist to avoid placing a bearer-style user-binding token on the OAuth-start URL.

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

- A messaging-platform update is transport input, not canonical product state by itself.
- Ingress should persist operational transport state in `bot_events` for linked users that enter normal processing.
- Ingress should persist canonical capture state in `inbox_items` before extraction creates or mutates downstream task state for linked users.
- The v1 unlinked-user Google connect gate is an explicit pre-ingress exception: Atlas may reply with a connect link and avoid persisting the inbound message entirely.
- Planner output may create or update `tasks`, but it must not overwrite the meaning of the original `inbox_items`.
- Scheduler output and calendar sync should update the task row's current commitment snapshot directly.
- Conversational schedule moves should resolve against persisted Atlas state instead of treating chat history as the scheduler's source of truth.

## Current schema vs MVP truth

- Atlas may contain schema elements and types that are ahead of the locked MVP.
- Existence in the schema does not automatically make a record part of active MVP truth.
- When implementation and MVP boundaries diverge, agents should follow the MVP-canonical model in this document unless the product scope is intentionally changed.
- If a data ownership change is intentional, update this doc alongside the code instead of letting the boundary drift silently.

## Current convergence note

- The architecture docs define `inbox_items` as canonical capture state for MVP.
- If a code path currently records `bot_events` before `inbox_items` exist durably, treat that as an implementation gap to close, not as a change to the ownership model.
