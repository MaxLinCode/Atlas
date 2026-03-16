# System Boundaries

## Purpose

This document defines which parts of the Atlas stack own which responsibilities for the MVP.

Its goal is to prevent logic from drifting into the wrong layer and to keep future agent work aligned with the product scope in `docs/product/mvp-requirements.md`.

## Stack components

- Telegram bot
- Vercel app and API layer
- Core package
- Model layer
- External calendar integration
- Neon Postgres database

## Telegram bot

### Owns

- Receiving freeform user messages
- Delivering reminder and follow-up messages back to the user
- Acting as the primary user-facing interaction surface for MVP

### Does not own

- Task state as the source of truth
- Scheduling rules
- Parsing or persistence decisions
- Business logic beyond transport-level message handling

### Notes

- Telegram is the planning conversation surface, not the product brain.
- Telegram payloads should be normalized and persisted before deeper processing decisions are made.

## Vercel app and API layer

### Owns

- Webhook entrypoints for Telegram
- Cron or scheduled entrypoints for reminder dispatch
- Request validation, authentication, and idempotency boundaries
- Webhook hardening such as rate limiting, abuse protection, and failed-auth observability
- Orchestration of core, repository, and integration calls
- Mode selection between conversation mode and mutation mode
- Minimal internal admin or debugging surfaces if needed

### Does not own

- Core planning heuristics embedded directly in route handlers
- Scheduling rules embedded directly in transport code
- Persistent business state outside the database

### Notes

- Route handlers should stay thin.
- Vercel is the delivery and orchestration layer, not the domain logic layer.
- Store webhook secrets only in environment-managed secret storage such as Vercel secrets.
- Never log webhook secrets in route logs, error messages, or debugging output.
- Because the Telegram webhook is publicly reachable, future hardening should include rate limiting or equivalent edge protections in addition to secret verification and idempotency.

## Core package

### Owns

- Product types and validation schemas
- Scheduling proposal rules
- Mutation validation and safe state-transition rules
- Accountability and follow-up policy rules for the MVP

### Does not own

- HTTP delivery concerns
- Telegram transport behavior
- Database writes by itself

### Notes

- Keep the MVP lean by preferring one cohesive product package over multiple speculative packages.
- Split `core` later only when real complexity or reuse demands it.

## Model layer

### Owns

- Conversational planning over messy user input
- Planning suggestions, prioritization help, and meta-use guidance in conversation mode
- Structured mutation proposals when the app selects mutation mode
- Confidence-limited inference where the input is messy but still usable

### Does not own

- Persistent product state
- Final authority on valid state transitions
- Reminder delivery
- Scheduling source of truth

### Notes

- Model output must be treated as untrusted until validated.
- The model helps Atlas think and propose actions; it does not decide what is persisted without application-side checks.
- Atlas should allow the model to be conversational without letting it become the system of record.

## External calendar integration

### Owns

- Canonical scheduled-time records for Atlas commitments
- Calendar event creation and update behavior through the integration boundary
- Availability reads needed for schedule-forward planning

### Does not own

- Task identity as the source of truth
- Accountability policy
- Product memory outside calendar records

### Notes

- Atlas owns tasks and accountability state even when the external calendar owns scheduled time.
- Calendar integration is a core execution dependency, not merely a future adapter.

## Neon Postgres database

### Owns

- Source-of-truth records for inbox items, tasks, accountability state, reminder state, and planner runs
- Processing status and retry-safe persistence
- Durable linkage between source messages, tasks, and external schedule references

### Does not own

- Transport behavior
- Model prompting strategy
- Scheduling policy by itself

### Notes

- The database is the canonical product memory.
- External systems may provide schedule truth, but Atlas-owned task and accountability state lives here.

## Cross-component rules

- Capture must succeed before deeper intelligence is attempted.
- Telegram messages should become persisted inbox items before Atlas mutates task state.
- Not every message should be forced through mutation logic; conversation mode is the default path.
- Model-produced mutation output must be validated against app-owned schemas before it becomes a task or schedule mutation.
- Scheduled time should come from the external calendar, not from broad recent-chat inference.
- Atlas should immediately seek scheduled time for tasks rather than treating unscheduled backlog as the normal state.
- Every scheduled task should receive follow-up after its scheduled block ends.
- Public webhook exposure requires layered defenses: secret verification, validation, ingress idempotency, and abuse controls such as rate limiting.

## MVP non-goals

- Telegram as the source of truth for tasks
- Unchecked model state mutations
- Unscheduled-task backlog as the normal operating model
- Forcing every message through mutation logic
- Business logic spread across webhook handlers
- Rich multi-surface clients beyond Telegram
