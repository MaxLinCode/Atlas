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
- App-layer orchestration for inbox processing over persisted Atlas state
- App-layer orchestration for both conversation mode and mutation mode over persisted Atlas state

### May read

- Persisted product state through repositories or application services
- Runtime configuration and environment settings

### May write

- Idempotent event records
- Persisted state changes, but only by calling core services or repositories

### Allowed decisions

- Request validation
- Authentication and authorization boundaries
- Idempotency handling
- Orchestration order across components
- Which persisted context to load before asking core to classify or schedule an inbox item
- Whether a turn stays in conversation mode or enters mutation mode
- Which context to load for the current mode before asking core or the model to reason about the turn

### Forbidden decisions

- Inline planning heuristics in route handlers
- Inline scheduling rules in route handlers
- Treating transient request state as durable business state

## Core package contract

### Role

`packages/core` owns product types, validation schemas, planning-action schemas, symbolic reference rules, and deterministic scheduling helpers for the MVP.
`packages/core` owns product types, mode-specific validation schemas, mutation-action schemas, symbolic reference rules for existing-item mutations, deterministic scheduling proposal helpers, and accountability policy rules for the MVP.

### Accepts

- Persisted inbox item content or normalized text
- App-owned user profile and availability data
- Application requests to plan, schedule, follow up on, complete, archive, or replan work

### Produces

- Structured planning-action schemas, symbolic reference rules, scheduling proposals, and ambiguity outcomes
- Structured mutation-action schemas, symbolic reference rules, scheduling proposals, follow-up outcomes, and ambiguity outcomes
- App-owned validation results and explainable decisions

### May read

- Runtime configuration and validated adapter responses
- Persisted product state passed in from the app or repository layer

### May write

- Nothing directly to the database or transport layers

### Allowed decisions

- Validation of model-produced planning output through app-owned schemas
- Validation of model-produced mutation output through app-owned schemas
- Scheduling heuristics that are deterministic and explainable
- Follow-up and accountability rules captured in product docs
- Replanning behavior within the product rules captured in docs
- Deterministic application of validated planning actions once the app resolves symbolic references to persisted records
- Deterministic application of validated mutation actions once the app resolves symbolic references to persisted records

### Forbidden decisions

- Direct database writes
- Direct Telegram delivery
- Framework-specific routing concerns

## OpenAI model contract

### Role

OpenAI interprets messy user text and returns structured planning output.
The model layer interprets messy user text and supports both conversational planning and structured mutation proposals.

### Accepts

- Persisted inbox item content or normalized text prepared by the application
- App-owned schema instructions, conversation instructions, and mutation constraints

### Produces

- Structured planning actions such as create task, create schedule block, move schedule block, or clarify
- Optional planning metadata such as confidence, ambiguity markers, and scheduling constraint hints
- Conversational planning responses, suggestions, and clarifications in conversation mode
- Structured mutation proposals such as create task, schedule task, move scheduled time, complete task, archive task, or clarify in mutation mode
- Optional metadata such as confidence, ambiguity markers, and scheduling constraint hints

### May read

- Only the prompt context explicitly provided by the application
- Structured preference, task, and schedule context selected according to `docs/architecture/ai-context-model.md`

### May write

- Nothing directly to the database or product state

### Allowed decisions

- Text interpretation within the provided planning task
- Proposing planning actions and symbolic references from the provided context
- Text interpretation within the provided planning or mutation task
- Conversational reasoning over recent transcript plus relevant state when the app selects conversation mode
- Proposing mutation actions and symbolic references from the provided context when the app selects mutation mode
- Limited inference where the text is messy but still reasonably recoverable

### Forbidden decisions

- Persisting records
- Triggering side effects directly
- Acting as the final validator of structured output
- Making autonomous scheduling or reminder mutations in the MVP
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

- An inbound Telegram message must be persisted as an inbox item before extraction can create or mutate downstream task state.
- OpenAI output must be validated against app-owned schemas before any record is created from it.
- OpenAI may reference existing tasks or schedule blocks only through app-provided symbolic aliases, never raw persistence ids.
- Conversational scheduling changes must resolve from persisted Atlas state, not from broad recent Telegram history.
- Scheduling state must be reconstructed from the database, not from Telegram history or model memory.
- Reminder dispatch must operate from persisted reminder or schedule state, not ad hoc prompt context.
- An inbound Telegram message must be persisted as an inbox item before Atlas mutates downstream task state.
- Conversation mode may use recent transcript plus relevant state, but transcript is not canonical state for mutations.
- Mutation mode output must be validated against app-owned schemas before any record is created or updated from it.
- Existing-item mutations must resolve against persisted Atlas state and explicit references, not broad recent-chat inference.
- Atlas owns task and accountability state even if an external calendar becomes the canonical source of scheduled time.
- Reminder and follow-up dispatch must operate from persisted Atlas state plus relevant external schedule linkage, not ad hoc prompt context.
- Each component should depend on the next narrowest interface available rather than reaching across layers opportunistically.

## MVP guardrails

- Keep contracts narrow and explicit.
- Prefer deterministic app-owned mutation rules over hidden model behavior.
- Keep transport concerns separate from core product decisions.
- Do not force every turn through mutation logic.
- Keep source-of-truth task and accountability state in Neon even when future integrations are added.
