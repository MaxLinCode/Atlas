# Atlas

Atlas is a Telegram-first brain-dump scheduler MVP. A user sends freeform text, the system turns it into structured tasks, places them onto a simple internal schedule, and follows up with Telegram reminders.

## Repo shape

- `apps/web`: the only deployable Next.js app
- `packages/core`: product types, validation schemas, planning logic, and scheduling rules for the MVP
- `packages/db`: Drizzle schema and persistence layer
- `packages/integrations`: Telegram, OpenAI, and future calendar adapters
- `docs`: product, architecture, decisions, and active project context
- `scripts`: local automation and repo utilities

## Commands

- `pnpm dev`: run the Next.js app locally
- `pnpm build`: build all workspaces
- `pnpm lint`: lint all workspaces
- `pnpm typecheck`: run TypeScript checks across the repo
- `pnpm test`: run the test suite
- `pnpm db:migrate`: run Drizzle migrations
- `pnpm db:studio`: open the Drizzle Studio workflow

## How We Work

This repo is designed for human-plus-agent collaboration.

- Keep route handlers thin and move product logic into packages.
- Prefer extending `packages/core` or a repository method over route-local logic.
- Every bug fix should add a regression test near the affected behavior.
- Update `docs/current-work.md` when priorities or handoff context changes.
- Capture architectural changes in `docs/decisions/`.

## MVP flow

1. Telegram webhook receives a freeform message and stores a raw inbox item.
2. Core planning logic extracts one or more basic tasks with structured OpenAI outputs.
3. Core scheduling logic assigns tasks onto a simple internal schedule.
4. Telegram sends reminders tied to scheduled tasks.
5. More advanced guidance, breakdown, and replanning are deferred beyond MVP.
