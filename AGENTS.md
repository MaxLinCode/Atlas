# AGENTS.md

## Mission

Build Atlas as a production-quality, Telegram-first planning assistant. The codebase should stay understandable to a new contributor and safe for repeated agent-driven edits.

## Architecture rules

- `apps/web` owns delivery surfaces only: API routes, cron entrypoints, and internal admin pages.
- Business logic belongs in `packages/*`, not in route handlers or page components.
- `packages/core` is the source of truth for product concepts, validation schemas, planning behavior, and scheduling rules.
- `packages/core` must not depend on Next.js route code or page components.
- `packages/db` implements persistence and repositories; do not spread SQL or ORM calls throughout the app.
- `packages/integrations` owns external API clients and transport adapters, not product logic.

## Anti-slop guardrails

- Prefer extending an existing module before creating a new abstraction.
- Do not add a dependency without a short reason in the change summary.
- No catch-all `utils` files unless the helpers are truly cross-cutting and cohesive.
- Keep files focused. If a file starts spanning multiple responsibilities, split by behavior.
- Keep comments rare and purposeful. Explain why, not what.

## Testing rules

- Every core business rule or planning/scheduling heuristic should have a unit test.
- Every webhook, reminder, or replanning bug fix requires an integration test.
- Structured OpenAI outputs must be validated at the boundary and covered by contract tests.

## Documentation rules

- Update `README.md` when setup or core commands change.
- Update `docs/architecture.md` when dependency direction or major flow changes.
- Add an ADR in `docs/decisions/` for meaningful infrastructure or architecture decisions.
- Update `docs/current-work.md` when the active implementation focus changes.

## Execution rules

- Before finishing, run the narrowest relevant checks for the touched code.
- For changes isolated to one package, prefer `pnpm --filter <package> typecheck` and `pnpm --filter <package> test`.
- For `apps/web` route or page changes, run `pnpm --filter @atlas/web typecheck` and the relevant app tests.
- For cross-package changes or shared type/schema changes, run `pnpm typecheck` and `pnpm test`.
- If dependencies, workspace config, Next.js config, or build tooling change, run `pnpm build`.
- In the final response, summarize which checks ran and call out anything not verified.

## Done definition

A task is complete when:

- the requested behavior exists,
- affected checks pass,
- docs are updated when setup, commands, or architecture changed,
- and any skipped verification is clearly called out.
