# Feature Delivery Workflow

Use this playbook for product features, behavior changes, and bug fixes that should ship through the normal Git and review flow.

## Goal

Keep delivery consistent across human and agent contributors while preserving Atlas's package boundaries, test expectations, and documentation hygiene.

## When to use this workflow

Use this workflow when you are:

- adding a new user-facing capability
- changing planning, scheduling, reminder, or webhook behavior
- fixing a production bug
- updating persistence, schemas, or integrations to support product behavior

For one-off exploration or local experiments, parts of this workflow may be intentionally skipped.

## Workflow

1. Sync the base branch.
   Start from the current integration branch, usually `main`, and pull the latest changes before branching.

2. Create a focused feature branch.
   Use the repo branch convention: `codex/<short-description>`.

3. Place changes in the correct layer.
   Keep `apps/web` limited to delivery surfaces.
   Put product concepts, planning behavior, validation, and scheduling rules in `packages/core`.
   Put persistence changes in `packages/db`.
   Put external API clients and adapters in `packages/integrations`.

4. Extend before abstracting.
   Prefer updating an existing module over creating a new abstraction when the behavior fits cleanly.

5. Add or update tests with the change.
   Add unit tests for core business rules and planning or scheduling heuristics.
   Add integration tests for webhook, reminder, and replanning bug fixes.
   Add contract coverage for structured OpenAI outputs at the validation boundary.

6. Update documentation when the change affects shared understanding.
   Update `README.md` for setup or command changes.
   Update `docs/architecture.md` for dependency direction or major flow changes.
   Update `docs/current-work.md` when the active implementation focus shifts.
   Add an ADR in `docs/decisions/` for meaningful architecture or infrastructure decisions.

7. Run the narrowest relevant verification.
   For isolated package changes, prefer `pnpm --filter <package> typecheck` and `pnpm --filter <package> test`.
   For `apps/web` route or page changes, run `pnpm --filter @atlas/web typecheck` and relevant app tests.
   For cross-package or shared schema changes, run `pnpm typecheck` and `pnpm test`.
   If tooling, workspace config, or build config changes, run `pnpm build`.

8. Commit clearly and open a reviewable PR.
   Use a clear commit message, such as `feat: add timezone-aware reminder scheduling`.
   In the PR, summarize what changed, why it changed, how it was tested, and any follow-up work or known risks.

## Review checklist

Before considering the work done, confirm:

- the requested behavior exists
- logic lives in the correct package
- the required tests were added or updated
- the relevant checks passed
- docs were updated when needed
- skipped verification is called out explicitly

## Atlas-specific reminders

- Keep route handlers thin.
- Avoid spreading SQL or ORM calls outside `packages/db`.
- Do not add dependencies without a short reason in the change summary.
- Prefer small, focused files over catch-all utilities.
