# Google Calendar Delivery Plan

## Goal

Ship real Google Calendar integration so Atlas can create and move actual calendar events, read busy time for scheduling, and keep task-owned commitment state as the canonical runtime model.

## Scope

- Google OAuth account linking
- linked-account and selected-calendar persistence
- real Google Calendar create, update, and read flows
- busy-time reads for scheduling and deterministic reschedule inputs
- failure handling for stale, deleted, or inaccessible events
- security hardening for linked private calendar access

## Non-goals for the first slice

- redesigning the task-owned commitment model
- replacing the locked follow-up runtime
- broad admin-surface work beyond what is needed to debug calendar linkage
- richer multi-calendar planning heuristics

## Delivery slices

### 1. Calendar foundation

Land the shared Google Calendar types, repository interfaces, and adapter seam without changing user-visible behavior.

Acceptance criteria:

- `apps/web` owns OAuth entrypoints only
- `packages/integrations` owns Google API calls
- `packages/db` owns linked-account persistence
- `tasks` remains the runtime source of truth for the current scheduled commitment
- the existing in-memory calendar adapter still works for tests

### 2. Linked account persistence

Add the database schema and repositories for Google account linkage, selected calendar identity, OAuth credentials, refresh metadata, and revocation state.

Acceptance criteria:

- linked Google account records round-trip through the repository layer
- selected calendar metadata is persisted explicitly
- token lifecycle fields required for refresh and revocation are represented
- data ownership remains aligned with `docs/architecture/data-model-boundaries.md`

### 3. OAuth web flow

Implement the Google OAuth start and callback handlers, including state issuance and validation, allowlisted-user checks, token exchange, and initial linked-account persistence.

Acceptance criteria:

- invalid or replayed OAuth state is rejected
- callback handling is app-owned and thin
- token exchange results are validated before persistence
- unauthorized users cannot link calendars

### 4. Real event write path

Replace the in-memory calendar adapter in the mutation runtime with a real Google-backed adapter for create, update, and read operations.

Acceptance criteria:

- mutation processing uses the linked Google adapter when a calendar is connected
- task commitment fields are persisted only after successful Google writes
- calendar create and update failures leave no partial task mutations behind
- task-to-event mapping remains explicit on the task row

### 5. Busy-time reads for scheduling

Introduce Google Calendar free/busy reads into scheduling availability checks and deterministic reschedule logic.

Acceptance criteria:

- busy-time normalization happens outside `packages/core`
- `packages/core` scheduling logic only consumes normalized availability inputs
- deterministic reschedule respects Google busy time and existing task commitments

### 6. Reconciliation and failure handling

Define what happens when an event is deleted, moved, or no longer accessible in Google.

Acceptance criteria:

- stale or missing event detection is explicit
- retry policy is defined for transient Google failures
- user-facing failure messages are clear when Atlas cannot honor a linked commitment
- minimal admin/debug visibility exists for broken calendar linkage

### 7. Security and launch hardening

Finish authz boundaries for calendar-linked operations, token revocation behavior, logging/redaction rules, and quota protection.

Acceptance criteria:

- calendar operations are gated by explicit user/account authz checks
- token revocation and disconnect behavior is defined
- logs do not leak sensitive token or calendar data
- launch blockers for linked private calendars are documented

### 8. Follow-up runtime integration

After the real calendar path is stable, thread it through the locked follow-up and deterministic reschedule runtime.

Acceptance criteria:

- post-block follow-ups operate against Google-backed commitments
- deterministic reschedules preserve task-owned commitment state and external event linkage
- follow-up runtime behavior does not depend on the in-memory test adapter

## Test expectations

- unit coverage for shared calendar normalization and scheduling boundary rules
- contract coverage for OAuth callback validation and Google response parsing
- integration coverage for event write success and rollback behavior
- integration coverage for busy-time reads in scheduling and deterministic reschedule paths
- integration coverage for stale-event and revoked-link handling

## Architecture guardrails

- keep route handlers thin
- do not spread Google API calls outside `packages/integrations`
- do not spread token or linked-account persistence outside `packages/db`
- do not let transcript or external calendar state replace task-owned runtime truth
- do not move scheduling heuristics out of `packages/core`

## ADR threshold

Create a new ADR only if we intentionally change a durable architecture rule, such as:

- task-owned commitment state no longer being the runtime source of truth
- a different ownership boundary for OAuth, linked-account persistence, or Google API transport
- a meaningful change in how Atlas reconciles task state against external calendar state
