# AI Context Model

This document defines how Atlas should provide context to AI systems for turn routing, conversation mode, and mutation mode.

## Goal

Atlas should feel continuous and context-aware while keeping prompts small, predictable, and grounded in structured product state.

The system should derive assistant continuity from a hybrid of recent conversation and durable state:

- structured user preferences
- recent relevant conversation turns
- explicit active task state
- current task state and accountability state
- relevant recent or upcoming schedule information
- planner and inbox-processing audit state when mutation or follow-up needs a safe anchor

It should not depend on replaying large chat transcripts as the canonical source of truth for product state.

## Memory principles

1. Store facts, not transcripts.
   Persist structured information about the user and their work instead of treating raw chat history as durable state.

2. Separate durable preferences from temporary task state.
   User preferences change infrequently. Task workflows are short-lived and should be modeled separately.

3. Use recent conversation where it improves the assistant.
   Recent transcript is valid context for turn routing and conversation mode when it improves planning dialogue, prioritization, meta-use, or short-horizon confirmation recovery.

4. Inject only relevant memory into prompts.
   Include only the minimum useful profile, task state, conversational context, and schedule context for the current operation.

5. Treat the database and external integrations as the source of truth for mutations.
   The model reasons over app-owned state and relevant external state. It should not act as the system of record.

## Memory layers

### User preferences

This is the long-term memory layer for stable scheduling and communication preferences.

Examples:

- timezone
- preferred work hours
- default task duration
- meeting buffer time
- days or times to avoid
- reminder preferences
- communication style

These preferences should be stored once, updated intentionally, and included in scheduling-related prompts when relevant.

Example:

```json
{
  "timezone": "America/Los_Angeles",
  "work_hours": { "start": "09:30", "end": "17:30" },
  "default_task_duration_minutes": 30,
  "buffer_minutes": 15,
  "avoid_times": ["Monday morning"],
  "reminder_minutes_before": 10
}
```

### Active task state

This is the short-term memory layer for in-progress assistant work.

Examples:

- a task currently being scheduled
- a clarification the system is waiting on
- a proposed time awaiting user confirmation

Example:

```json
{
  "task_type": "schedule_task",
  "status": "awaiting_confirmation",
  "title": "Lunch with Sarah",
  "proposed_time": "2026-03-17T12:00:00Z"
}
```

This layer prevents the assistant from losing track of the current workflow without treating the full chat as durable state.

For the conversation-first MVP, this layer may be informed by recent conversation plus persisted task and audit state.
For mutation work and follow-up handling, it should be reconstructed from persisted task state, current commitment linkage, and planner/audit state rather than loosely replayed chat messages.
When prompting the model for mutation mode, existing tasks or schedule-linked records should still be represented with app-generated symbolic aliases or explicit application references rather than raw database ids.

### Schedule state

Schedule data should come from Atlas's integrations and persisted linkage, not from the model's memory.

Representative tool or service calls include:

- `get_schedule`
- `find_available_slots`
- `create_task`
- `update_task`

Atlas should treat the external calendar as the canonical source of scheduled time while retaining Atlas-owned task and accountability state in the database.

## Mode-specific context

### Turn router

Turn routing should use:

1. System instructions for app-owned routing modes
2. User preferences only if relevant to disambiguating the turn
3. Recent relevant conversation turns
4. Active tasks and unresolved follow-up state relevant to the turn
5. Minimal schedule context needed to understand whether the turn is conversational or mutating
6. The user's latest message

This mode is optimized for choosing between `conversation`, `mutation`, `conversation_then_mutation`, and `confirmed_mutation`. It should stay lighter than a full conversational prompt, but it may use more recent transcript than mutation mode because v1 confirmation recovery is intentionally short-horizon and transcript-assisted.

The app must fetch the bounded recent-turn window before invoking the router prompt so short-horizon context is available, while memory summaries are only produced when they demonstrably add clarity (e.g., to resolve references or describe a pending proposal) and are not the default routing input.

### Conversation mode

Conversation mode should use:

1. System instructions
2. User preferences
3. Recent relevant conversation turns
4. Active tasks and accountability state relevant to the turn
5. Relevant recent or upcoming schedule information
6. The user's latest message

This mode is optimized for fluid planning conversation, prioritization help, reflective guidance, and schedule-forward proposals without forcing mutation. Conversation mode may use a broader recent transcript window than mutation mode because continuity and natural replies matter more here than minimum-context mutation safety.

### Mutation mode

Mutation mode should use only what is necessary to safely execute a confirmed or clearly intended change:

1. System instructions
2. User preferences
3. Relevant recent conversation turns if needed for clarity
4. Exact target task and schedule references
5. Relevant current schedule information
6. The user's latest message

This mode is optimized for validated task, scheduling, completion, archive, and reschedule writes. Mutation mode should stay narrower than conversation mode and use transcript only as needed for clarity or short-horizon confirmation, not as canonical memory.

## Design implications

- Prompt construction should be mode-dependent rather than forcing every turn through the same planning context.
- Prompt construction should distinguish among router, conversation, and mutation prompts rather than treating all model calls as one planner task.
- Prompt construction may read recent conversation in conversation mode, but should not treat transcript as canonical state.
- Prompt construction may use recent transcript for turn routing and short-horizon confirmation recovery in v1, but persisted Atlas state remains the source of truth for mutations.
- `confirmed_mutation` should be reserved for short-horizon confirmations or concrete refinements of one recent proposed write; ambiguous confirmations should stay in `conversation_then_mutation`.
- Prompt construction should provide model-readable references for existing tasks and current schedule-linked records so the app can safely resolve proposed mutations.
- Structured mutation output must be validated at the application boundary before it can create or mutate product state.
- Atlas should not try to reconstruct all conversational continuity from normalized database records alone.
- Scheduling and follow-up decisions should be explainable from stored preferences, Atlas task state, and external schedule state.
- Conversational schedule adjustments should only be attempted when Atlas has one safe target or explicit linkage.

## Relationship to Atlas architecture

- `packages/core` should define the schemas and product rules for router-aware and mode-aware context.
- `packages/db` should persist durable user preferences, active task state, task state, and audit records.
- `packages/integrations` should not own user memory semantics; it should only transport model or messaging-platform inputs and outputs.
- `apps/web` should orchestrate retrieval of the relevant context for each turn, route the turn, and choose the correct model path without embedding product logic in route handlers.
