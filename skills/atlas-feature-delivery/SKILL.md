---
name: atlas-feature-delivery
description: Execute non-trivial Atlas features, bug fixes, and behavior changes inside the repo's delivery workflow. Use when Codex needs to implement or update Atlas product behavior and must respect branch rules, package boundaries, test expectations, and documentation hygiene.
---

# Atlas Feature Delivery

Follow the Atlas workflow before editing:

1. Confirm the current branch is not `main`. If it is, create a focused branch named `codex/<short-description>` before making changes.
2. Read `CLAUDE.md`, `docs/workflows/feature-delivery.md`, and the smallest set of architecture or product docs needed for the task.
3. Map the change to the correct layer before editing:
   - `apps/web` for delivery surfaces only
   - `packages/core` for product concepts, validation, planning, and scheduling rules
   - `packages/db` for persistence and repositories
   - `packages/integrations` for external clients, prompts, and adapters
4. Prefer extending an existing module over creating a new abstraction. Avoid catch-all utilities.

Implement with these guardrails:

- Keep route handlers thin.
- Keep SQL and ORM access inside `packages/db`.
- Do not add dependencies unless there is a clear need to mention in the change summary.
- Keep comments rare and focused on why a decision exists.

Before finishing:

1. Update tests with the change. Use unit tests for core rules, integration tests for webhook or runtime regressions, and contract coverage for structured model outputs.
2. Update docs only when the change alters shared understanding:
   - `README.md` for setup or command changes
   - `docs/architecture.md` for dependency direction or major flow changes
   - `docs/current-work.md` when the active implementation focus changes
   - `docs/decisions/` for meaningful architecture or infrastructure decisions
3. Run the narrowest relevant checks required by `CLAUDE.md`.

In the final response, summarize:

- what changed
- which checks ran
- which checks were intentionally skipped
- any dependency additions and why
