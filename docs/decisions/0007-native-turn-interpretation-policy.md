# ADR 0007: Native turn interpretation and policy

## Status

Accepted

## Context

ADR 0006 introduced an app-owned turn router, but the first implementation still inherited legacy route semantics from a model-assisted route classifier. That meant old route names such as `conversation`, `mutation`, `conversation_then_mutation`, and `confirmed_mutation` continued to influence turn meaning, confidence, ambiguity, and execution behavior.

This left Atlas with a split-brain routing model:

- execution was nominally policy-driven
- interpretation still depended on legacy route categories
- clear write-ready requests could remain stuck in proposal-first behavior because the old router was conservative

Atlas now has enough persisted conversation state to make routing decisions directly from message text plus conversation state without treating legacy route names as semantic inputs.

## Decision

Use native app-owned interpretation and policy as the routing brain.

- `interpretTurn` must derive turn meaning from message text plus conversation state only.
- `decideTurnPolicy` must derive action from interpretation, conversation state, and explicit product rules only.
- Legacy route names may remain as compatibility output at the webhook boundary, but they must not influence interpretation, confidence, ambiguity, policy, or execution branching.
- Clear write-ready scheduling and edit requests should execute directly unless an explicit product rule requires proposal-first confirmation.
- Proposal-first behavior is no longer the fallback for medium-confidence writes.
- Confirmation recovery remains a supported path, but only when one recoverable proposal is active in state.

## Consequences

- Routing behavior becomes deterministic and easier to debug locally.
- Conversation-state quality becomes more important because proposal recovery, clarification handling, and focused-edit routing depend on persisted state rather than classifier labels.
- Manual router prompt tuning is no longer part of the core turn-routing path.
- Compatibility route names can be removed later without changing the routing brain.

## Guardrails

- Do not reintroduce legacy route names as routing inputs.
- Do not use webhook response compatibility fields as product-state semantics.
- Do not make proposal-first behavior the default fallback for write-like turns.
- Keep mutation execution gated by explicit policy actions only.
