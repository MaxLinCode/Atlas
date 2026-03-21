---
name: atlas-planning-change
description: Update Atlas planning, scheduling, routing, clarification, or mutation behavior without breaking the app-owned state model. Use when Codex changes planner rules, scheduling heuristics, mutation contracts, turn routing, or conversation-to-mutation boundaries.
---

# Atlas Planning Change

Start by reading `docs/architecture.md` and `docs/current-work.md`. For data ownership questions, read `docs/architecture/data-model-boundaries.md`. For turn-routing behavior, also read `docs/decisions/0006-conversational-turn-routing.md`.

Keep these boundaries intact:

- Put product semantics, schemas, and scheduling rules in `packages/core`.
- Keep final state mutation and symbolic reference resolution in application or repository code, not in prompts.
- Treat recent conversation context as non-canonical continuity context, not product memory.
- Keep `tasks` as the active runtime source of truth for current schedulable work.
- Preserve `referenceTime` as the shared temporal anchor when working on scheduling interpretation or busy-time lookups.

When changing planner or router behavior:

1. Identify whether the change is a pure rule change, a schema contract change, or an orchestration change.
2. Edit the smallest existing module that owns that responsibility.
3. Validate structured model output at the boundary before it reaches runtime mutation logic.
4. Keep explanations traceable from validated output to persisted state changes.

Testing expectations:

- Add or update unit tests for business rules and scheduling heuristics.
- Add or update contract tests for structured OpenAI outputs.
- Add integration coverage if the change affects webhook-to-mutation flow, clarification recovery, or persisted runtime behavior.

Do not let a prompt edit silently redefine the product contract. If the contract changes, update the owning schemas, tests, and docs together.
