---
name: atlas-google-calendar-flow
description: Change Atlas Google Calendar linking, OAuth, event writes, busy-time reads, reconciliation, or disconnect flows safely. Use when Codex edits linked-calendar runtime behavior, Google auth handoff, calendar sync logic, or task-to-calendar authority boundaries.
---

# Atlas Google Calendar Flow

Read these before editing:

- `docs/workflows/google-calendar-delivery.md`
- `docs/decisions/0007-google-calendar-authority-and-sync.md`
- `docs/decisions/0008-security-lockdown-and-google-oauth-handoff.md`
- `docs/architecture/data-model-boundaries.md`

Preserve these architecture rules:

- `apps/web` owns Google entrypoints and thin callback orchestration only.
- `packages/integrations` owns Google API transport and response normalization.
- `packages/db` owns linked-account persistence and token lifecycle persistence.
- Atlas owns task identity and accountability state.
- Google Calendar is the authority for scheduled-time reality.
- Atlas persists the task-level commitment projection only after successful Google writes.

Security and runtime guardrails:

- Keep one-time handoff, link-session, OAuth-state, and token domains separate.
- Do not leak tokens or private calendar data through logs or admin surfaces.
- Do not allow external calendar state to replace Atlas task-owned runtime truth.
- Keep busy-time normalization outside `packages/core`; pass normalized availability into core scheduling logic.

Testing expectations:

- Add contract coverage for OAuth callback validation and Google response parsing.
- Add integration coverage for write success, rollback behavior, busy-time reads, and revoked or stale link handling.
- Run the narrowest relevant `@atlas/web`, `@atlas/db`, and `@atlas/integrations` checks that cover the touched path.
