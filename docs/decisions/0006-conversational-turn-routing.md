# ADR 0006: Conversational turn routing

## Status

Accepted

## Context

Atlas is a Telegram-first planning assistant, not just a mutation pipeline. The current model-facing path is primarily structured inbox planning, which is useful for safe writes but too narrow for the broader conversational behavior Atlas needs for planning dialogue, reflective help, and natural schedule-forward proposals.

We need one durable rule for model behavior that:

- preserves a safe structured mutation path
- allows broader conversational responses without forcing every turn through a write-oriented planner
- keeps turn routing app-owned rather than hidden inside one catch-all prompt
- permits a fast v1 path toward more conversational Telegram behavior without treating transcript as canonical product state

## Decision

Use a two-path, app-routed model behavior for Telegram turns.

- Atlas has two model-facing turn paths:
  - `ConversationPath` for natural-language planning dialogue, reflection, prioritization, meta-use, and schedule-forward proposals without required writes
  - `MutationPath` for validated structured mutation proposals and results
- Every inbound Telegram turn is routed through an app-owned `TurnRouter`.
- `TurnRouter` selects one of:
  - `conversation`
  - `mutation`
  - `conversation_then_mutation`
- The router is model-assisted in v1.
- Mixed turns are conversation-first in v1:
  - Atlas should discuss, clarify, or propose first
  - mutation should occur only on a later confirming turn
- Mutation remains the only write-capable path.
- Conversation turns may be broad and helpful, but they must not claim that side effects happened unless the mutation path actually ran.
- Transcript may be used as recent conversational context and short-horizon confirmation context in v1, but transcript is still not canonical product state.
- Richer conversational proposals are allowed, but any write still requires the structured mutation path.

## Consequences

- Atlas should feel more conversational and planning-assistant-first in Telegram.
- Some turns will require more than one model call because routing, conversation, and mutation are distinct responsibilities.
- Mode-specific context construction becomes more important because router, conversation, and mutation prompts should not all receive the same context payload.
- Transcript-inferred confirmation is acceptable as a v1 speed tradeoff, but it is not a permanent commitment to transcript as durable product memory.

## Deferred implementation slices

1. turn router
2. conversational response path
3. mutation reply renderer
4. mixed-turn confirmation handling

## Guardrails

- Do not collapse conversation and mutation back into one catch-all model path.
- Do not let the conversation path write product state directly.
- Do not treat Telegram transcript as the source of truth for mutations.
- Do not let richer conversational proposals bypass the structured mutation path.
- Keep turn routing, mutation validation, and persistence boundaries explicit in app-owned code.
