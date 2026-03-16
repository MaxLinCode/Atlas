# Architecture

This document is the top-level technical overview for Atlas. Focused architecture topics live in `docs/architecture/`.

## Core modes

Atlas should support two complementary modes:

1. Conversation mode
   The user is thinking, reflecting, asking meta questions, prioritizing, or discussing work without necessarily requesting side effects.
2. Mutation mode
   The user is clearly asking Atlas to create, schedule, move, or otherwise mutate canonical task or schedule state.

## Conversation mode flow

1. Telegram sends a webhook event to `apps/web`.
2. The webhook route validates the event, derives an idempotency key from Telegram `update_id`, records the incoming bot event once, skips duplicate deliveries, and stores an inbox item only for first-seen events.
3. An app-layer service loads only the context needed for the current turn, which may be lightweight conversational context, user preferences, relevant recent schedule information, or the full persisted task-and-schedule graph for a mutation.
4. The model returns a conversational response, optional planning suggestions, and optionally a decision that the turn should enter mutation mode.

## Mutation mode flow

1. When the turn clearly implies side effects, the app prepares a structured planning request with the relevant persisted task and schedule context, including symbolic aliases for existing tasks and schedule blocks when needed.
2. The OpenAI Responses API returns structured planning actions that are validated against app-owned schemas in `packages/core`.
3. The app service resolves symbolic references against persisted Atlas state, then repository-layer persistence records `planner_runs`, creates or updates `tasks` and `schedule_blocks`, and advances the inbox item to `planned`, `needs_clarification`, or a retryable failure state.
4. Telegram reminders, follow-ups, and future conversational replies operate from persisted Atlas state rather than transient webhook context.

## Dependency direction

- `apps/web` -> `packages/*`
- `packages/core` -> `packages/integrations` when external clients are needed
- `packages/db` -> no app or framework packages
- `packages/integrations` -> external SDKs
- `packages/core` -> no app or framework packages

`packages/core` is the center of the MVP model. It defines the system vocabulary and the first-pass rules for conversational planning, extraction, scheduling, and replanning.

## Design principles

- Accept input fast, then process it against persisted Atlas state instead of relying on chat transcripts.
- Prefer schedule-forward task handling in MVP so extracted work gets placed onto time, not left as open-ended backlog by default.
- Keep every scheduling decision explainable and traceable to a planner run plus validated model output.
- Keep conversational scheduling anchored to persisted tasks and schedule blocks, not broad recent-message inference.
- Let the model propose actions, but keep final state mutation and symbolic-reference resolution in the application layer.
- Accept input fast, then process it against persisted Atlas state and relevant conversational context instead of relying on broad transcript replay.
- Be conversation-first and schedule-forward: Atlas should support fluid planning dialogue, but bias toward turning actionable work into time.
- Do not force every turn through a mutation pipeline.
- Keep every scheduling decision explainable and traceable to validated model output plus canonical state changes.
- Keep mutations anchored to persisted tasks and schedule blocks, not broad recent-message inference.
- Let the model own conversation and proposal quality, but keep final state mutation and symbolic-reference resolution in the application layer.
- Preserve future seams for Google Calendar without leaking calendar concepts into core scheduling tables.
- Optimize for reliable execution and observability before optimization or clever abstraction.
- Keep the MVP lean: prefer one cohesive product package over multiple speculative internal packages.
- For MVP, Telegram user IDs are the canonical persisted user identifier; introduce an internal Atlas UUID mapping only when multi-surface identity becomes a real product need.

## Related docs

- `docs/architecture/data-model-boundaries.md`: canonical, operational, derived, and deferred data ownership rules
- `docs/architecture/component-contracts.md`: per-component input, output, and mutation rules
- `docs/architecture/system-boundaries.md`: stack ownership for Telegram, Vercel, OpenAI, and Neon Postgres
- `docs/product/mvp-requirements.md`: product scope and explicit non-goals for the MVP
