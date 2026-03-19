# ADR 0007: Google Calendar authority and Atlas task projection

## Status

Accepted

## Context

Atlas is moving from a test-only in-memory calendar seam to a real Google Calendar integration for scheduling, moving work, and reading busy time. That introduces a durable architecture question:

- which system is authoritative for scheduled-time reality
- which fields Atlas owns locally for low-latency behavior
- when Atlas should read Google directly versus trust its own projection
- how Atlas should behave when Google and Atlas drift apart

We need one explicit rule so scheduling, reconciliation, OAuth/account-link persistence, and follow-up/runtime work all share the same ownership model.

## Decision

Use Google Calendar as the authority for scheduled-time reality, while Atlas owns task identity, accountability state, and the local task-level commitment projection.

- Google Calendar is authoritative for whether a linked event exists and what its live scheduled time is.
- Atlas `tasks` remain the canonical Atlas record for task identity, lifecycle state, follow-up state, inbox provenance, and the local commitment snapshot.
- The task-level local projection is:
  - `external_calendar_event_id`
  - `external_calendar_id`
  - `scheduled_start_at`
  - `scheduled_end_at`
- Atlas does not read Google on every turn.
- Atlas uses write-through projection for Atlas-originated mutations:
  - write to Google first
  - only persist the task projection after Google succeeds
- Before updating an existing linked event, Atlas verifies the live Google event.
- If the live event is missing or materially drifted from the Atlas projection, Atlas marks the task out of sync and clarifies instead of silently overwriting either side.
- Busy-time reads stay outside `packages/core` and are normalized into scheduler-consumable busy blocks before scheduling logic runs.
- V1 account scope is one linked Google account and one selected writable calendar per Atlas user.
- V1 synchronization uses:
  - fetch-before-update for risky writes
  - periodic bounded reconciliation for recently touched and near-future scheduled tasks
  - no event-mirror table
  - no webhook-first sync dependency

## Consequences

- Atlas gets low-latency reads from local task state without pretending local state is globally authoritative.
- Atlas-originated writes remain transactional from the product perspective: no local commitment mutation is persisted unless Google accepts the write.
- Direct edits in Google can be detected and surfaced safely through reconciliation or fetch-before-update.
- `packages/core` remains Google-agnostic because busy-time inputs are normalized before they reach scheduling logic.
- Scheduling or move attempts without a linked Google calendar must clarify instead of silently falling back to a fake calendar.

## Guardrails

- Do not reintroduce implicit in-memory calendar fallback in app runtime code.
- Do not treat Google event payloads as the source of truth for Atlas task identity or accountability state.
- Do not silently overwrite Atlas projection from Google drift or overwrite Google from stale Atlas state in v1.
- Keep OAuth/account-link persistence app- and db-owned; do not spread token handling into unrelated runtime modules.
- If Atlas later adopts webhook-driven sync, multi-calendar planning, or a mirrored external-event table, update this ADR rather than letting the authority model drift silently.
