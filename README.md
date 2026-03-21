# Atlas

Atlas is a chat-first brain-dump scheduler MVP. A user sends freeform text, the system turns it into structured tasks, places them onto a simple internal schedule, and follows up through its messaging bot surface.

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
- `pnpm eval:all`: run the full live OpenAI prompt-eval loop and write a consolidated report to `packages/integrations/manual-eval-report.json`
- `pnpm eval:confirmed-mutation-recovery`: run the live OpenAI confirmed-mutation recovery eval fixture set against the current prompt
- `pnpm eval:conversation-context`: run the live OpenAI conversation-context eval fixture set against the current prompt
- `pnpm eval:planner`: run the live OpenAI planner eval fixture set against the current prompt
- `pnpm eval:router-confirmation`: run the live OpenAI router-confirmation eval fixture set against the current prompt
- `pnpm eval:turn-router`: run the live OpenAI turn-router eval fixture set against the current prompt
- `pnpm lint`: lint all workspaces
- `pnpm typecheck`: run TypeScript checks across the repo
- `pnpm test`: run the test suite
- `pnpm telegram:webhook:set`: register the Telegram webhook and print Telegram's current webhook info
- `pnpm db:generate`: generate a new Drizzle migration from schema changes
- `pnpm db:migrate`: apply existing Drizzle migrations to the configured database
- `pnpm db:studio`: open the Drizzle Studio workflow
- `pnpm db:test:start`: start the local Homebrew Postgres test service and create `atlas_test`
- `pnpm db:test:reset`: reset the local `atlas_test` database schema for integration reruns
- `pnpm db:test:stop`: stop the local Homebrew Postgres test service

## Prompt Improvement Loop

Atlas treats prompt changes as product behavior changes. Use the live eval harness to iterate on prompts deliberately instead of editing blind.

Recommended loop:

1. Edit the owning prompt, schema, or parser in `packages/integrations` and `packages/core` together when the contract changes.
2. Run the narrowest relevant live eval first:
   - `pnpm eval:planner`
   - `pnpm eval:turn-router`
   - `pnpm eval:router-confirmation`
   - `pnpm eval:conversation-context`
   - `pnpm eval:confirmed-mutation-recovery`
3. Inspect the suite-specific report written under `packages/integrations/*.manual-eval-report.json`.
4. If the suite fails, inspect the generated prompt-improvement brief under `packages/integrations/*.prompt-improvement.md` and use it as the starting point for the next prompt revision.
5. Tighten the prompt or contract based on the actual failing model output.
6. Run `pnpm eval:all` before merging to confirm the full prompt surface still passes together.

Notes:

- `pnpm eval:all` writes the canonical consolidated report to `packages/integrations/manual-eval-report.json`.
- Single-suite evals write suite-specific reports such as `packages/integrations/conversation-context.manual-eval-report.json`.
- Failing suites also write suite-specific prompt-improvement briefs such as `packages/integrations/conversation-context.prompt-improvement.md`.
- Generated eval reports are ignored by git and should not be committed.
- Generated prompt-improvement briefs are also ignored by git and should not be committed.
- Live evals help judge prompt quality, but they do not replace deterministic tests and schema validation.

## Local Integration DB

Atlas supports an explicit local Postgres workflow for integration tests on macOS with Homebrew `postgresql@16`.

Typical flow:

1. Run `pnpm db:test:start`
2. Create `apps/web/.env.test.local` with `DATABASE_URL='postgresql://$USER@localhost:5432/atlas_test'`
3. Run `pnpm --filter @atlas/integration-tests test`
4. Run `pnpm db:test:stop` when you are done

Notes:

- These commands are convenience helpers for local integration testing, not part of normal app startup.
- The scripts expect Homebrew `postgresql@16` and target the disposable `atlas_test` database by default.
- `pnpm db:test:reset` is useful if you want a clean local database between manual test runs.

## Environment

Copy `.env.example` into `apps/web/.env.local` for local development and provide real values through your deployment environment for hosted runs.
For local-only test credentials, prefer `apps/web/.env.test.local`, which is gitignored and loaded by the Next app, Drizzle config, and integration test runner.

- `DATABASE_URL`: Postgres connection string
- `APP_BASE_URL`: canonical deployed app origin used when generating Google Calendar connect links
- `OPENAI_API_KEY`: OpenAI API key
- `TELEGRAM_BOT_TOKEN`: Telegram bot token
- `TELEGRAM_WEBHOOK_SECRET`: shared secret used to verify Telegram webhook deliveries
- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated Telegram user id allowlist for private-beta access; required in all environments
- `GOOGLE_CLIENT_ID`: Google OAuth client id for Calendar linking
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret for Calendar linking
- `GOOGLE_OAUTH_REDIRECT_URI`: OAuth callback URL for Google Calendar linking
- `GOOGLE_LINK_TOKEN_SECRET`: secret used only for one-time Telegram-to-browser Google link handoff tokens
- `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte key used to encrypt stored Google access and refresh tokens
- `CRON_SECRET`: bearer token required for protected cron routes such as Google Calendar reconciliation

To register the production Telegram webhook once those values are set, also export `ATLAS_WEBHOOK_URL` as the full deployed route URL and run `pnpm telegram:webhook:set`.

For hosted rollout steps, use [`docs/workflows/production-deploy-checklist.md`](docs/workflows/production-deploy-checklist.md) as the main production deploy runbook and [`docs/workflows/vercel-telegram-webhook.md`](docs/workflows/vercel-telegram-webhook.md) for the narrower webhook-only setup flow.

Atlas no longer exposes public planner/debug mutation routes. The intended externally reachable surfaces are:

- `POST /api/telegram/webhook`
- `GET /google-calendar/connect`
- `GET /api/google-calendar/oauth/start`
- `GET /api/google-calendar/oauth/callback`
- protected cron routes that require `Authorization: Bearer $CRON_SECRET`

## How We Work

This repo is designed for human-plus-agent collaboration.

- Keep route handlers thin and move product logic into packages.
- Prefer extending `packages/core` or a repository method over route-local logic.
- Every bug fix should add a regression test near the affected behavior.
- Update `docs/current-work.md` when priorities or handoff context changes.
- Capture architectural changes in `docs/decisions/`.

## Repo-local Skills

Atlas includes repo-specific Codex skills under [`skills/`](./skills). These are versioned with the repo so they can evolve with Atlas architecture, workflow rules, and testing expectations rather than living as global defaults.

Current skills:

- `atlas-feature-delivery`
- `atlas-planning-change`
- `atlas-webhook-and-conversation`
- `atlas-schema-and-migration`
- `atlas-openai-contracts-and-evals`
- `atlas-google-calendar-flow`
- `atlas-reviewer`

Use these when working inside Atlas and the task matches the skill name. Keep the repo copy as the source of truth.

## MVP flow

1. The current messaging webhook receives a freeform message.
2. If the sender is allowlisted but does not have an active Google Calendar connection, the app replies with a signed Google connect link and stops before ingress persistence.
3. Linked users enter the normal flow: the app persists the inbox item, loads relevant task, schedule, and user-profile context, and sends a structured planning request through the OpenAI Responses API.
4. Validated planning actions create or update tasks and schedule blocks through the repository layer.
5. The messaging bot sends reminders tied to scheduled tasks.
