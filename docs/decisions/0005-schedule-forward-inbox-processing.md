# ADR 0005: Schedule-forward inbox processing

## Status

Accepted

## Context

Atlas is a chat-first planning assistant, not a passive task bucket. The MVP already treats `inbox_items` as canonical captured input, but the original stubbed planner path was task-extraction-centric and did not define how conversational scheduling requests or schedule adjustments should be handled.

We need one durable rule for inbox processing that:

- keeps capture fast and durable
- turns safe task capture into time placement by default
- supports follow-up scheduling messages without relying on broad chat-history inference
- keeps business logic split cleanly across app orchestration, core rules, and repository persistence

## Decision

Use a schedule-forward, model-driven inbox-processing model for MVP.

- `inbox_items` remain the canonical record of accepted user input.
- Every inbox item is processed from persisted Atlas state through a structured OpenAI Responses API planning step.
- The model returns validated planning actions such as create task, create schedule block, move schedule block, or clarify.
- When Atlas can safely extract a task, it should also try to place that task onto the internal schedule immediately.
- When the user delegates slot choice or gives a broad but usable timing preference, Atlas should prefer scheduling from availability or a sensible inferred time instead of immediately asking for an exact hour.
- Conversational scheduling changes must resolve from persisted Atlas state such as `tasks`, `schedule_blocks`, `user_profiles`, and `planner_runs`, not from broad recent chat history.
- Existing persisted records are exposed to the model only through app-generated symbolic aliases, not raw database ids.
- `apps/web` owns orchestration for `process-inbox-item`.
- `packages/core` owns validation, symbolic reference rules, ambiguity rules, and deterministic scheduling logic.
- `packages/integrations` owns the Responses API client call.
- `packages/db` owns loading processing context and committing inbox, task, schedule, and planner-run mutations.

## Consequences

- Atlas optimizes for structured time rather than unscheduled backlog accumulation.
- `planner_runs` become a required audit trail for every inbox-processing attempt.
- Scheduling logic is simple and deterministic in MVP, but it is applied after validated model planning output rather than local heuristic parsing.
- Conversational schedule moves are allowed only when persisted state provides a safe target; otherwise the inbox item should end in clarification rather than guesswork.
- `schedule_blocks` should attach directly to canonical `tasks` in MVP scheduling flows instead of making deferred `task_actions` the active planning unit.

## Guardrails

- Do not move orchestration into route handlers.
- Do not treat chat transcripts as durable memory.
- Do not add speculative conversation-memory abstractions when persisted task and schedule state is sufficient.
- Do not let the model write raw ids or mutate state directly.
- Keep scheduling decisions explainable and reconstructable from stored state and planner runs.
