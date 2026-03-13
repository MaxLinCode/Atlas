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

## Telegram bot contract

### Role

Telegram is the MVP interaction surface for inbound capture and outbound reminders.

### Accepts

- Freeform user messages
- Telegram delivery metadata needed to identify the sender and conversation

### Produces

- Normalized inbound message payloads for the application layer
- Outbound user-visible messages such as reminders and basic status responses

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

### Forbidden decisions

- Inline planning heuristics in route handlers
- Inline scheduling rules in route handlers
- Treating transient request state as durable business state

## Core package contract

### Role

`packages/core` owns product types, validation schemas, extraction behavior, and scheduling rules for the MVP.

### Accepts

- Persisted inbox item content or normalized text
- App-owned user profile and availability data
- Application requests to plan, schedule, or replan work

### Produces

- Structured task candidates and scheduling proposals
- App-owned validation results and explainable decisions

### May read

- Runtime configuration and validated adapter responses
- Persisted product state passed in from the app or repository layer

### May write

- Nothing directly to the database or transport layers

### Allowed decisions

- Text interpretation and validation through app-owned schemas
- Scheduling heuristics that are deterministic and explainable
- Replanning behavior within the product rules captured in docs

### Forbidden decisions

- Direct database writes
- Direct Telegram delivery
- Framework-specific routing concerns

## OpenAI model contract

### Role

OpenAI interprets messy user text and returns structured extraction output.

### Accepts

- Persisted inbox item content or normalized text prepared by the application
- App-owned schema instructions and extraction constraints

### Produces

- Structured task candidates
- Optional extraction metadata such as confidence or ambiguity markers

### May read

- Only the prompt context explicitly provided by the application
- Structured preference, task, and schedule context selected according to `docs/architecture/ai-context-model.md`

### May write

- Nothing directly to the database or product state

### Allowed decisions

- Text interpretation within the provided extraction task
- Limited inference where the text is messy but still reasonably recoverable

### Forbidden decisions

- Persisting records
- Triggering side effects directly
- Acting as the final validator of extracted structure
- Making autonomous scheduling or reminder mutations in the MVP

## Neon Postgres contract

### Role

Neon Postgres is the canonical persistence layer for Atlas.

### Accepts

- Validated state changes from the application and repository layers
- Idempotent event and processing records

### Produces

- Durable product records
- Queryable source-of-truth state for inbox items, tasks, schedule blocks, reminders, and planner runs

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
- Scheduling state must be reconstructed from the database, not from Telegram history or model memory.
- Reminder dispatch must operate from persisted reminder or schedule state, not ad hoc prompt context.
- Each component should depend on the next narrowest interface available rather than reaching across layers opportunistically.

## MVP guardrails

- Keep contracts narrow and explicit.
- Prefer deterministic app-owned rules over hidden model behavior.
- Keep transport concerns separate from core product decisions.
- Keep source-of-truth state in Neon even when future integrations are added.
