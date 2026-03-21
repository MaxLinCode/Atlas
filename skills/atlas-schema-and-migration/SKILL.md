---
name: atlas-schema-and-migration
description: Change Atlas persisted records, Drizzle schema, migrations, or repository APIs safely. Use when Codex edits database schema, migration files, repository methods, persisted task or inbox fields, or any data ownership boundary tied to Atlas runtime state.
---

# Atlas Schema And Migration

Read `docs/architecture/data-model-boundaries.md` before changing schema or repositories. Use it to classify the affected data as canonical, operational, derived, external-reference, or deferred.

Follow this workflow:

1. Identify which record owns the truth being changed.
2. Confirm the new field or table belongs in that ownership boundary.
3. Put persistence behavior in `packages/db`; do not spread SQL or ORM access elsewhere.
4. Prefer extending existing repository methods over adding parallel access paths.
5. Generate or update the smallest correct migration set.

Guardrails:

- `tasks` remains the active runtime truth for current schedulable work.
- `inbox_items` remains canonical capture state.
- `schedule_blocks` is transitional or deferred, not the place to reintroduce runtime truth.
- External ids may reference outside systems, but they do not replace Atlas-owned product state.

Testing and docs:

- Add repository tests for new persistence behavior.
- Add integration coverage when schema changes alter webhook, reminder, replanning, or calendar-linked flows.
- Update `docs/architecture/data-model-boundaries.md` if data ownership changes intentionally.
- Update architecture docs or add an ADR if the change alters a durable boundary rather than just extending the current model.
