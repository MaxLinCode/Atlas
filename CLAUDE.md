# Claude Instructions

These instructions define the required search and discovery workflow.
These rules take precedence over other exploration strategies.
Always follow this protocol before reading multiple files or performing refactors.
If you are about to search broadly or read many files, stop and apply this protocol first.

## Global Priorities

1. Minimize unnecessary file reads and token usage
2. Follow the Search & Discovery Protocol before broad exploration
3. Respect package ownership boundaries
4. Prefer modifying existing modules over creating new ones

## Search & Discovery Protocol

1. File Discovery (fd)
- Always start with fd
- Prefer fd over `rg --files` for file enumeration
- Never use find or ls -R
- If results >200 files, refine
- Example: fd -e ts auth


2. Text Search (rg)
- Use rg for literals and narrowing
- Prefer -l / --files-with-matches first to identify target files
- Use -S (smart-case) to avoid casing misses
- Scope by extension when possible
- If results >50 files, refine
- Example: rg -S -t ts --files-with-matches "useAuth"

3. Structural Search (sg)
- Use sg for syntax-aware queries
- Run after fd/rg narrowing
- Remember that many TS functions are arrow functions; use broader patterns when needed
- Examples:
  - sg -p 'function $NAME($$$) { $$$ }'
  - sg -p 'const $NAME = ($$$) => { $$$ }'

4. Read Minimally
- Prefer rg -n -C 3 over full file reads
- Read order: config → entry → tests → impl

5. Refactor Safety
- Use fd to scope before large changes
- Verify file count
- Sample a few files first

Power Pattern (bounded scan):
fd -e ts . src/logic/ -x sg -p 'function $F($$$) { $$$ }'

Note:
- Use only when the directory is already narrow (<50 files)
- This is a shortcut for function inventory, not for whole-repo scans
- If unsure, run `fd` first to confirm file count

## Codebase Map

High-level module ownership:

- `apps/web` — delivery surfaces (API routes, cron entrypoints, admin pages)
- `packages/core` — product logic, planning behavior, schemas, scheduling rules
- `packages/db` — persistence, repositories, database access
- `packages/integrations` — external APIs and transport adapters
- `docs/` — architecture, workflows, and decision records

Navigation hints:

- Start in `packages/core` for business logic questions
- Start in `apps/web` for request/route entrypoints
- Start in `packages/db` for data access or persistence issues
- Start in `packages/integrations` for external API behavior
- Check `docs/architecture.md` for system-level flows

## Mission

Build Atlas as a production-quality, Telegram-first planning assistant. The codebase should stay understandable to a new contributor and safe for repeated agent-driven edits.

## Architecture Rules

- `apps/web` owns delivery surfaces only: API routes, cron entrypoints, and internal admin pages.
- Business logic belongs in `packages/*`, not in route handlers or page components.
- `packages/core` is the source of truth for product concepts, validation schemas, planning behavior, and scheduling rules.
- `packages/core` must not depend on Next.js route code or page components.
- `packages/db` implements persistence and repositories; do not spread SQL or ORM calls throughout the app.
- `packages/integrations` owns external API clients and transport adapters, not product logic.

## Anti-Slop Guardrails

- Prefer extending an existing module before creating a new abstraction.
- Do not add a dependency without a short reason in the change summary.
- No catch-all `utils` files unless the helpers are truly cross-cutting and cohesive.
- Keep files focused. If a file starts spanning multiple responsibilities, split by behavior.
- Keep comments rare and purposeful. Explain why, not what.

## Testing Rules

- Every core business rule or planning/scheduling heuristic should have a unit test.
- Every webhook, reminder, or replanning bug fix requires an integration test.
- Structured OpenAI outputs must be validated at the boundary and covered by contract tests.

## Documentation Rules

- Update `README.md` when setup or core commands change.
- Update `docs/architecture.md` when dependency direction or major flow changes.
- When touching schemas, migrations, persisted records, ingestion record creation, or core data types, verify the change matches `docs/architecture/data-model-boundaries.md` and update that doc if the ownership model changes.
- Add an ADR in `docs/decisions/` for meaningful infrastructure or architecture decisions.
- Update `docs/current-work.md` when the active implementation focus changes.

### Git Workflow Rules

- Every workflow — no exceptions — must use a git worktree and a dedicated branch.
  - Create a worktree before touching any files:
    `git worktree add .worktrees/atlas-<short-description> -b claude/<short-description>`
  - All edits, experiments, and commits must happen inside that worktree.
  - Never modify files in the main checkout.

- Do not commit or push implementation work directly to `main`.
  - If work is accidentally committed on `main`, move it to a feature branch before pushing.

- All changes must land via a dedicated branch.
  - Prefer PR-based merges, even for small changes.
  - Fast-forward merges from a clean branch are acceptable after work is complete.

- Commit per logical change, not per file.
- Stage only files related to the current change.
- Write descriptive commit messages explaining the intent.

- Follow `docs/workflows/feature-delivery.md` for product features, fixes, and behavior changes.

- Clean up after completion:
  - `git worktree remove .worktrees/atlas-<short-description>`
  - `git branch -d claude/<short-description>` (if fully merged)

## Execution Rules

- Before finishing, run the narrowest relevant checks for the touched code.
- For changes isolated to one package, prefer `pnpm --filter <package> typecheck` and `pnpm --filter <package> test`.
- For `apps/web` route or page changes, run `pnpm --filter @atlas/web typecheck` and the relevant app tests.
- For cross-package changes or shared type/schema changes, run `pnpm typecheck` and `pnpm test`.
- If dependencies, workspace config, Next.js config, or build tooling change, run `pnpm build`.
- In the final response, summarize which checks ran and call out anything not verified.

## Done Definition

A task is complete when:

- the requested behavior exists,
- affected checks pass,
- docs are updated when setup, commands, or architecture changed,
- and any skipped verification is clearly called out.