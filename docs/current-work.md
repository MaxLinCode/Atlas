# Current Work

## Active focus

Leaner MVP package structure and first real vertical slice for the Telegram-first MVP.

## Near-term milestones

- Wire the Next.js app to the simplified workspace packages.
- Define the first Drizzle schema and repository interfaces.
- Implement Telegram webhook ingestion with idempotent bot events.
- Add core planning contract schemas and basic scheduling input/output types.
- Build the minimal internal admin views for inspection and debugging.

## Handoff notes

- The repo is intentionally workspace-ready but lean for MVP: `core`, `db`, and `integrations` are the only packages.
- Google Calendar is a future adapter only; do not build sync logic yet.
- MVP scope is locked in `docs/product/mvp-requirements.md`.
- Keep route handlers thin and push product logic into packages.
