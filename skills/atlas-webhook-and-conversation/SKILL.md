---
name: atlas-webhook-and-conversation
description: Change Atlas webhook ingress, inbound processing, turn routing, or conversation response flows while keeping route handlers thin and state boundaries clean. Use when Codex edits Telegram webhook code, inbox processing, turn-router logic, conversation replies, or follow-up delivery paths.
---

# Atlas Webhook And Conversation

Read `docs/architecture.md`, `docs/current-work.md`, and `docs/decisions/0004-telegram-webhooks.md`. For routing behavior, read `docs/decisions/0006-conversational-turn-routing.md`.

Apply these ownership rules:

- Keep `apps/web` limited to route validation, auth checks, request shaping, and orchestration.
- Keep persistence in `packages/db`.
- Keep model prompt and transport client code in `packages/integrations`.
- Keep product interpretation and canonical state rules in `packages/core` or the app-owned orchestration layer that already owns the flow.

Ingress and conversation guardrails:

- Treat transport payloads as transport input, not canonical product state by themselves.
- Preserve the linked-user gate and pre-ingress exception for unlinked users where applicable.
- Do not let conversational turns claim that side effects happened unless the mutation path actually ran.
- Keep conversational continuity bounded and non-authoritative.
- Split lazy-link gate replies, inbox processing, and outbound follow-up delivery by responsibility rather than folding them into one handler.

Testing expectations:

- Add integration tests for webhook regressions and reply-loop bugs.
- Add focused tests for turn-router or conversation-response behavior when routing semantics change.
- Verify duplicate-delivery and idempotency behavior whenever ingress handling changes.
