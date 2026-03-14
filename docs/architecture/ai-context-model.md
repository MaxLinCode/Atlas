# AI Context Model

This document defines how Atlas should provide context to AI systems without relying on long conversation history.

## Goal

Atlas should feel continuous and context-aware while keeping prompts small, predictable, and grounded in structured product state.

The system should derive assistant continuity from:

- structured user preferences
- explicit active task state
- schedule data retrieved from the database
- planner and inbox-processing audit state when conversational scheduling needs a safe anchor

It should not depend on replaying large chat transcripts to reconstruct user intent.

## Memory principles

1. Store facts, not transcripts.
   Persist structured information about the user and their work instead of raw chat history wherever possible.

2. Separate durable preferences from temporary task state.
   User preferences change infrequently. Task workflows are short-lived and should be modeled separately.

3. Inject only relevant memory into prompts.
   Include the minimum useful profile, active task state, and schedule context for the current operation.

4. Treat the database as the source of truth.
   The model reasons over app-owned state. It should not act as the system of record.

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

For schedule-forward MVP inbox processing, this layer should be reconstructed from persisted task, schedule block, and planner-run state rather than from loosely replayed Telegram messages.
When prompting the model, existing tasks and schedule blocks should be represented with app-generated symbolic aliases rather than raw database ids.

### Schedule state

Schedule data should come from Atlas's internal persistence layer rather than the model's memory.

Representative tool or service calls include:

- `get_schedule`
- `find_available_slots`
- `create_task`
- `update_task`

The database remains the canonical source of truth for scheduled work, reminders, and task state.

## Prompt context structure

Each model request should include only the context needed for the current operation:

1. System instructions
2. User preferences
3. Active task state, if any
4. Relevant schedule information
5. Relevant planner or processing anchor state, if any
6. The user's latest message

This keeps prompts compact while preserving continuity and reducing token cost.

## Design implications

- Prompt construction should read structured state from repositories or application services, not from raw chat logs.
- Prompt construction should provide model-readable symbolic references for existing tasks and schedule blocks so the app can safely resolve proposed actions.
- Structured model output must be validated at the application boundary before it can create or mutate product state.
- Telegram history should not be treated as canonical memory.
- Scheduling and reminder decisions should be explainable from stored preferences and schedule state.
- Conversational schedule adjustments should only be attempted when persisted Atlas state provides one safe target or explicit linkage.

## Relationship to Atlas architecture

- `packages/core` should define the schemas and product rules for memory-backed context.
- `packages/db` should persist durable user preferences, active task state, and schedule records.
- `packages/integrations` should not own user memory semantics; it should only transport model or Telegram inputs and outputs.
- `apps/web` should orchestrate retrieval of the relevant context for each request without embedding product logic in route handlers.
