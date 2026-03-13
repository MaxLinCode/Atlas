# System Boundaries

## Purpose

This document defines which parts of the Atlas stack own which responsibilities for the MVP.

Its goal is to prevent logic from drifting into the wrong layer and to keep future agent work aligned with the product scope in `docs/product/mvp-requirements.md`.

## Stack components

- Telegram bot
- Vercel app and API layer
- Core package
- OpenAI model layer
- Neon Postgres database

## Telegram bot

### Owns

- Receiving freeform user messages
- Delivering reminder messages back to the user
- Acting as the primary user-facing interaction surface for MVP

### Does not own

- Task state as the source of truth
- Scheduling rules
- Parsing or persistence decisions
- Business logic beyond transport-level message handling

### Notes

- Telegram is an input and output channel, not the product brain.
- Telegram payloads should be normalized and persisted before deeper processing decisions are made.

## Vercel app and API layer

### Owns

- Webhook entrypoints for Telegram
- Cron or scheduled entrypoints for reminder dispatch
- Request validation, authentication, and idempotency boundaries
- Orchestration of core, repository, and integration calls
- Minimal internal admin or debugging surfaces if needed

### Does not own

- Core planning heuristics embedded directly in route handlers
- Scheduling rules embedded directly in transport code
- Persistent business state outside the database

### Notes

- Route handlers should stay thin.
- Vercel is the delivery and orchestration layer, not the domain logic layer.

## Core package

### Owns

- Product types and validation schemas
- Extraction logic and schedule proposal rules
- Replanning behavior for the MVP

### Does not own

- HTTP delivery concerns
- Telegram transport behavior
- Database writes by itself

### Notes

- Keep the MVP lean by preferring one cohesive product package over multiple speculative packages.
- Split `core` later only when real complexity or reuse demands it.

## OpenAI model layer

### Owns

- Turning messy inbox text into structured task candidates
- Returning machine-generated structured outputs for extraction
- Providing confidence-limited inference where the input is messy but still usable

### Does not own

- Persistent product state
- Final authority on valid state transitions
- Reminder delivery
- Scheduling source of truth

### Notes

- Model output must be treated as untrusted until validated.
- OpenAI helps interpret input; it does not decide what is persisted without application-side checks.
- For MVP, the model is used for extraction, not full assistant autonomy.

## Neon Postgres database

### Owns

- Source-of-truth records for inbox items, tasks, schedule blocks, reminder state, and planner runs
- Processing status and retry-safe persistence
- Durable linkage between source messages and extracted tasks

### Does not own

- Transport behavior
- Model prompting strategy
- Scheduling policy by itself

### Notes

- The database is the canonical product memory.
- External systems may provide events or suggestions, but persisted state lives here.

## Cross-component rules

- Capture must succeed before deeper intelligence is attempted.
- Telegram messages should become persisted inbox items before core planning logic mutates task state.
- OpenAI output must be validated against app-owned schemas before it becomes a task or schedule record.
- Scheduling decisions should be persisted in Neon and delivered through Telegram, not reconstructed from chat history.
- Future integrations such as Google Calendar should be adapters around the core system, not replacements for internal state ownership.

## MVP non-goals

- Telegram as the source of truth for tasks
- OpenAI making unchecked state mutations
- Calendar-driven scheduling ownership
- Business logic spread across webhook handlers
- Rich multi-surface clients beyond Telegram
