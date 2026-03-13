# Architecture

This document is the top-level technical overview for Atlas. Focused architecture topics live in `docs/architecture/`.

## Core flow

1. Telegram sends a webhook event to `apps/web`.
2. The webhook route validates the event, records an idempotent bot event, and stores an inbox item.
3. Core planning logic turns the inbox item into basic tasks.
4. Core scheduling logic assigns those tasks to internal schedule slots based on simple availability rules.
5. Telegram sends reminders using persisted bot events for retry safety.

## Dependency direction

- `apps/web` -> `packages/*`
- `packages/core` -> `packages/integrations` when external clients are needed
- `packages/db` -> no app or framework packages
- `packages/integrations` -> external SDKs
- `packages/core` -> no app or framework packages

`packages/core` is the center of the MVP model. It defines the system vocabulary and the first-pass rules for extraction, scheduling, and replanning.

## Design principles

- Accept input fast, then process asynchronously or behind a lightweight job boundary.
- Start with basic tasks and simple schedule placement before adding richer task shaping.
- Keep every scheduling decision explainable and traceable to a planner run.
- Preserve future seams for Google Calendar without leaking calendar concepts into core scheduling tables.
- Optimize for reliable execution and observability before optimization or clever abstraction.
- Keep the MVP lean: prefer one cohesive product package over multiple speculative internal packages.

## Related docs

- `docs/architecture/component-contracts.md`: per-component input, output, and mutation rules
- `docs/architecture/system-boundaries.md`: stack ownership for Telegram, Vercel, OpenAI, and Neon Postgres
- `docs/product/mvp-requirements.md`: product scope and explicit non-goals for the MVP
