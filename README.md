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
- `pnpm telegram:webhook:set`: register the Telegram webhook and print Telegram's current webhook info
- `pnpm db:migrate`: run Drizzle migrations
- `pnpm db:studio`: open the Drizzle Studio workflow
- `pnpm db:test:start`: start the local Homebrew Postgres test service and create `atlas_test`
- `pnpm db:test:reset`: reset the local `atlas_test` database schema for integration reruns
- `pnpm db:test:stop`: stop the local Homebrew Postgres test service

## Local Integration DB

Atlas supports an explicit local Postgres workflow for integration tests on macOS with Homebrew `postgresql@16`.

Typical flow:

1. Run `pnpm db:test:start`
2. Run `DATABASE_URL='postgresql://$USER@localhost:5432/atlas_test' pnpm --filter @atlas/integration-tests test`
3. Run `pnpm db:test:stop` when you are done

Notes:

- These commands are convenience helpers for local integration testing, not part of normal app startup.
- The scripts expect Homebrew `postgresql@16` and target the disposable `atlas_test` database by default.
- `pnpm db:test:reset` is useful if you want a clean local database between manual test runs.

## Environment

Copy `.env.example` for local development and provide real values through your deployment environment for hosted runs.

- `DATABASE_URL`: Postgres connection string
- `OPENAI_API_KEY`: OpenAI API key
- `TELEGRAM_BOT_TOKEN`: Telegram bot token
- `TELEGRAM_WEBHOOK_SECRET`: shared secret used to verify Telegram webhook deliveries

To register the production Telegram webhook once those values are set, also export `ATLAS_WEBHOOK_URL` as the full deployed route URL and run `pnpm telegram:webhook:set`.

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
