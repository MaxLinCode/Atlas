# Architecture

This document is the top-level technical overview for Atlas. Focused architecture topics live in `docs/architecture/`.

## Core flow

1. Telegram sends a webhook event to `apps/web`.
2. The webhook route validates the event, derives an idempotency key from Telegram `update_id`, records the incoming bot event once, skips duplicate deliveries, and stores an inbox item only for first-seen events.
3. An app-layer inbox-processing service loads persisted task and schedule context, then prepares a model input with symbolic aliases for existing tasks and schedule blocks.
4. The OpenAI Responses API returns structured planning actions that are validated against app-owned schemas in `packages/core`.
5. The app service resolves symbolic references against persisted Atlas state, then repository-layer persistence records `planner_runs`, creates or updates `tasks` and `schedule_blocks`, and advances the inbox item to `planned`, `needs_clarification`, or a retryable failure state.
6. Telegram reminder and future conversational reply delivery operate from persisted Atlas state rather than transient webhook context.

## Dependency direction

- `apps/web` -> `packages/*`
- `packages/core` -> `packages/integrations` when external clients are needed
- `packages/db` -> no app or framework packages
- `packages/integrations` -> external SDKs
- `packages/core` -> no app or framework packages

`packages/core` is the center of the MVP model. It defines the system vocabulary and the first-pass rules for extraction, scheduling, and replanning.

## Design principles

- Accept input fast, then process it against persisted Atlas state instead of relying on chat transcripts.
- Prefer schedule-forward task handling in MVP so extracted work gets placed onto time, not left as open-ended backlog by default.
- Keep every scheduling decision explainable and traceable to a planner run plus validated model output.
- Keep conversational scheduling anchored to persisted tasks and schedule blocks, not broad recent-message inference.
- Let the model propose actions, but keep final state mutation and symbolic-reference resolution in the application layer.
- Preserve future seams for Google Calendar without leaking calendar concepts into core scheduling tables.
- Optimize for reliable execution and observability before optimization or clever abstraction.
- Keep the MVP lean: prefer one cohesive product package over multiple speculative internal packages.
- For MVP, Telegram user IDs are the canonical persisted user identifier; introduce an internal Atlas UUID mapping only when multi-surface identity becomes a real product need.

## Related docs

- `docs/architecture/data-model-boundaries.md`: canonical, operational, derived, and deferred data ownership rules
- `docs/architecture/component-contracts.md`: per-component input, output, and mutation rules
- `docs/architecture/system-boundaries.md`: stack ownership for Telegram, Vercel, OpenAI, and Neon Postgres
- `docs/product/mvp-requirements.md`: product scope and explicit non-goals for the MVP
