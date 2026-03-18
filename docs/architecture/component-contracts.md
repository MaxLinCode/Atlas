# Component Contracts

## Purpose

This document defines the working contract for each major MVP component in Atlas.

A component contract describes:

- what the component accepts
- what the component produces
- what state it may read or write
- what decisions it is allowed to make
- what it must not do

Use this document to keep implementation work aligned across agents and to prevent business logic from drifting into the wrong layer.

Atlas now operates in two complementary modes:

- conversation mode: planning dialogue, reflection, prioritization, meta-use, and schedule proposals without required side effects
- mutation mode: validated task, scheduling, completion, archive, and reschedule writes
- turn routing mode: app-owned routing that selects whether a turn stays conversational, enters mutation, or uses a conversation-first path before later mutation

Every turn begins in conversation mode. Mutation mode runs only on clear user intent or after Atlas proposes a concrete change and the user confirms it.

## Telegram bot contract

### Role

Telegram is the MVP interaction surface for planning conversation, reminders, and follow-up accountability.

### Accepts

- Freeform user messages
- Telegram delivery metadata needed to identify the sender and conversation

### Produces

- Normalized inbound message payloads for the application layer
- Outbound user-visible messages such as follow-ups, reminders, scheduling confirmations, and conversational responses

### May read

- Nothing as a source of truth on its own

### May write

- Nothing directly to product state without passing through the application layer

### Allowed decisions

- Transport-level normalization of Telegram payload shape
- Delivery retry behavior at the transport boundary if needed

### Forbidden decisions

- Deciding task structure
- Mutating schedule state
- Treating Telegram chat history as canonical product memory
- Embedding business rules in bot transport handlers

## Vercel app and API contract

### Role

The Vercel layer is the entrypoint and orchestrator for the system.

### Accepts

- Webhook events from Telegram
- Scheduled or cron-triggered reminder runs
- Internal admin or debug requests if those surfaces exist

### Produces

- Validated requests to core, integration, and repository layers
- HTTP responses and operational outcomes for transport boundaries
- App-layer orchestration for both conversation mode and mutation mode over persisted Atlas state
- App-layer turn routing over persisted Atlas state before the app chooses the model path for the turn

### May read

- Persisted product state through repositories or application services
- The bounded recent-turn window for the current user, loaded before routing and distilled only when adding value so summaries remain opt-in rather than default inputs
- Runtime configuration and environment settings

### May write

- Idempotent event records
- Persisted state changes, but only by calling core services or repositories

### Allowed decisions

- Request validation
- Authentication and authorization boundaries
- Idempotency handling
- Orchestration order across components
- Turn routing across `conversation`, `mutation`, `conversation_then_mutation`, and `confirmed_mutation`
- Which persisted context to load before asking core to classify or schedule an inbox item
- Whether a turn stays in conversation mode or enters mutation mode
- Which context to load for the current mode before asking core or the model to reason about the turn, including whether a summary is needed or if recent turns alone suffice

### Forbidden decisions

- Inline planning heuristics in route handlers
- Inline scheduling rules in route handlers
- Treating transient request state as durable business state

## Core package contract

### Role

`packages/core` owns product types, turn-routing and confirmation-recovery schemas, mode-specific validation schemas, mutation-action schemas, symbolic reference rules for existing-item mutations, deterministic scheduling proposal helpers, and accountability policy rules for the MVP.

### Accepts

- Persisted inbox item content or normalized text
- App-owned user profile and availability data
- Application requests to plan, schedule, follow up on, complete, archive, or replan work

### Produces

- Turn-routing schemas, structured mutation-action schemas, symbolic reference rules, scheduling proposals, follow-up outcomes, and ambiguity outcomes
- App-owned validation results and explainable decisions

### May read

- Runtime configuration and validated adapter responses
- Persisted product state passed in from the app or repository layer

### May write

- Nothing directly to the database or transport layers

### Allowed decisions

- Validation of model-produced turn-routing output through app-owned schemas
- Validation of model-produced confirmation-recovery output through app-owned schemas
- Validation of model-produced mutation output through app-owned schemas
- Scheduling heuristics that are deterministic and explainable
- Follow-up and accountability rules captured in product docs
- Replanning behavior within the product rules captured in docs
- Deterministic application of validated mutation actions once the app resolves symbolic references to persisted records

### Forbidden decisions

- Direct database writes
- Direct Telegram delivery
- Framework-specific routing concerns

## Model layer contract

### Role

The model layer interprets messy user text for three app-selected responsibilities: turn routing, conversational planning, and structured mutation proposals.
`packages/integrations` owns the transport wrappers, prompt text, and API calls for those model tasks, but it should parse against core-owned schemas rather than defining the product contracts itself.

### Accepts

- Persisted inbox item content or normalized text prepared by the application
- App-owned schema instructions, conversation instructions, and mutation constraints

### Produces

- Turn-routing classifications such as `conversation`, `mutation`, `conversation_then_mutation`, or `confirmed_mutation`
- Conversational planning responses, suggestions, and clarifications in conversation mode
- Structured mutation proposals such as create task, schedule task, move scheduled time, complete task, archive task, or clarify in mutation mode
- Optional metadata such as confidence, ambiguity markers, and scheduling constraint hints

### May read

- Only the prompt context explicitly provided by the application
- Structured preference, task, and schedule context selected according to `docs/architecture/ai-context-model.md`

### May write

- Nothing directly to the database or product state

### Allowed decisions

- Text interpretation within the provided routing, planning, or mutation task
- Classifying a turn into the app-owned routing modes from the provided context
- Conversational reasoning over recent transcript plus relevant state when the app selects conversation mode
- Proposing mutation actions and symbolic references from the provided context when the app selects mutation mode
- Limited inference where the text is messy but still reasonably recoverable

### Forbidden decisions

- Persisting records
- Triggering side effects directly
- Acting as the final validator of structured output
- Acting as canonical conversational memory
- Making autonomous task, schedule, or reminder mutations in the MVP

## Neon Postgres contract

### Role

Neon Postgres is the canonical persistence layer for Atlas.

### Accepts

- Validated state changes from the application and repository layers
- Idempotent event and processing records

### Produces

- Durable product records
- Queryable source-of-truth state for inbox items, tasks, accountability state, and planner/audit records

### May read

- All persisted product state through defined repositories or queries

### May write

- Canonical product state
- Operational records needed for retries, deduplication, and traceability

### Allowed decisions

- Enforcing data integrity through schema constraints
- Preserving durable history and record linkage

### Forbidden decisions

- Owning business rules by itself
- Replacing application-side validation
- Becoming tightly coupled to a specific external integration's state model

## Shared contract rules

- An inbound Telegram message must be persisted as an inbox item before Atlas mutates downstream task state.
- Conversation mode may use recent transcript plus relevant state, but transcript is not canonical state for mutations.
- The app should own `TurnRouter` and select `ConversationPath` or `MutationPath` explicitly rather than relying on one catch-all model prompt.
- Mutation mode output must be validated against app-owned schemas before any record is created or updated from it.
- Only the mutation path may write or trigger product-state changes.
- Existing-item mutations must resolve against persisted Atlas state and explicit references, not broad recent-chat inference.
- Atlas owns task and accountability state even if an external calendar becomes the canonical source of scheduled time.
- Reminder and follow-up dispatch must operate from persisted Atlas state plus relevant external schedule linkage, not ad hoc prompt context.
- A task enters `awaiting_followup` only after Atlas has sent the first follow-up for the ended commitment, not merely because time has passed.
- First-follow-up eligibility is `lifecycle_state = scheduled` plus `scheduled_end_at <= now`.
- Reminder eligibility is `lifecycle_state = awaiting_followup`, `followup_reminder_sent_at IS NULL`, `last_followup_at IS NOT NULL`, and `now >= last_followup_at + 2 hours`.
- If an unresolved follow-up exists and the user sends a new request, Atlas should handle the new request first, then circle back to the oldest unresolved follow-up.
- If multiple tasks are overdue, Atlas should surface unresolved follow-ups one by one rather than batching them into a single broad prompt.
- Late follow-up replies should resolve strictly: only clear completion closes the task as `done`, only clear cancel intent archives it, partial progress does not count as completion, and a not-done reply without a usable future scheduling signal must stay unresolved and be steered toward reschedule or archive.
- A not-done reply with a non-concrete but schedulable future preference should trigger an availability-backed concrete proposal rather than a generic clarification prompt.
- The automatic reschedule path should remain deterministic and narrow. Richer AI-generated schedule rearrangement proposals are allowed, but they require explicit confirmation before mutation.
- `apps/web` should orchestrate three runtime paths over the same persisted follow-up state: background follow-up/reminder dispatch, inbound webhook turn handling, and a single turn-boundary drain pass after inbound processing completes.
- `packages/core` should own the pure selectors for oldest-unresolved ordering, first-follow-up eligibility, reminder eligibility, and deterministic reschedule proposal rules.
- `packages/db` should own the repository queries, transactional state transitions, and per-user concurrency guard used by follow-up dispatch and inbound turn handling.
- For a given user, only one runtime actor may evaluate and mutate follow-up state at a time. Follow-up dispatch, inbound webhook processing, and turn-boundary drain must share the same per-user lock.
- The turn-boundary drain exists to satisfy the product rule that Atlas should not interrupt an active conversational turn with a newly due follow-up. If a follow-up becomes due during the turn, Atlas should send it immediately after the turn completes rather than waiting for the next background dispatch tick.
- Each component should depend on the next narrowest interface available rather than reaching across layers opportunistically.

## MVP guardrails

- Keep contracts narrow and explicit.
- Prefer deterministic app-owned mutation rules over hidden model behavior.
- Keep transport concerns separate from core product decisions.
- Do not force every turn through mutation logic.
- Keep source-of-truth task and accountability state in Neon even when future integrations are added.
