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
2. The webhook route validates the event and resolves the Telegram user.
3. If the user is allowlisted but does not have an active Google Calendar connection, the app replies with a signed Google connect link and stops before canonical ingress persistence.
4. Linked users continue through the normal ingress path: the webhook derives an idempotency key from Telegram `update_id`, records the incoming bot event once, skips duplicate deliveries, and stores an inbox item only for first-seen events.
5. An app-layer service loads only the context needed for the current turn, which may be a bounded recent-turn window plus a request-scoped working summary for conversational continuity, relevant user preferences or schedule information, or the full persisted task-and-schedule graph for a mutation.
6. The model returns a conversational response, optional planning suggestions, and optionally a decision that the turn should enter mutation mode.

## Mutation mode flow

1. When the turn clearly implies side effects, the app prepares a structured planning request with the relevant persisted task and schedule context, including symbolic aliases for existing tasks and schedule blocks when needed.
2. The OpenAI Responses API returns structured planning actions that are validated against app-owned schemas in `packages/core`.
3. The app service resolves symbolic references against persisted Atlas state, then repository-layer persistence records `planner_runs`, creates or updates `tasks` and `schedule_blocks`, and advances the inbox item to `planned`, `needs_clarification`, or a retryable failure state.
4. Telegram reminders, follow-ups, and future conversational replies operate from persisted Atlas state rather than transient webhook context.
5. When a user has linked Google Calendar, the app resolves the selected writable calendar from persisted linkage state, writes schedule mutations through Google first, then persists the returned task-level commitment projection locally.
6. Google Calendar linking now starts from a one-time Telegram-to-browser handoff and a short-lived server-side link session before OAuth start, rather than a bearer-style user token on the OAuth-start URL.
7. Existing linked commitments may be verified against Google before risky updates, while background reconciliation keeps Atlas's task-level projection converged without requiring a live Google fetch on every turn.

## Dependency direction

- `apps/web` -> `packages/*`
- `packages/core` -> `packages/integrations` when external clients are needed
- `packages/db` -> no app or framework packages
- `packages/integrations` -> external SDKs
- `packages/core` -> no app or framework packages

`packages/core` is the center of the MVP model. It defines the system vocabulary and the first-pass rules for conversational planning, extraction, scheduling, and replanning.

## Design principles

- Accept input fast, then process it against persisted Atlas state instead of relying on chat transcripts.
- For v1, treat an active Google Calendar connection as the entry ticket for meaningful Telegram use; unlinked users should receive a connect flow before Atlas persists or plans their message.
- Use bounded recent transcript context only for conversational continuity; it is not canonical Atlas memory.
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
- Keep Google Calendar as the authority for scheduled-time reality while Atlas owns task identity, accountability state, and the local task-level commitment projection.
- Use write-through local projection plus bounded reconciliation rather than fetching Google on every read.
- Keep the public app surface minimal: Telegram webhook, Google linking routes, and explicitly protected cron entrypoints only.
- Separate security domains across webhook verification, cron auth, Google handoff signing, and token encryption.
- Optimize for reliable execution and observability before optimization or clever abstraction.
- Keep the MVP lean: prefer one cohesive product package over multiple speculative internal packages.
- For MVP, Telegram user IDs are the canonical persisted user identifier; introduce an internal Atlas UUID mapping only when multi-surface identity becomes a real product need.

## Related docs

- `docs/architecture/data-model-boundaries.md`: canonical, operational, derived, and deferred data ownership rules
- `docs/architecture/component-contracts.md`: per-component input, output, and mutation rules
- `docs/architecture/system-boundaries.md`: stack ownership for Telegram, Vercel, OpenAI, and Neon Postgres
- `docs/product/mvp-requirements.md`: product scope and explicit non-goals for the MVP
