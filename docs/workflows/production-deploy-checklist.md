# Production Deploy Checklist

## Purpose

Use this checklist for a real Atlas deploy to Vercel when the target environment should support:

- Telegram webhook ingestion
- Google Calendar linking and OAuth callback handling
- protected cron routes

This is the deployment runbook for the current locked-down private-beta shape of the app.

## Preconditions

- The target branch is reviewed and ready to release.
- The Vercel project is connected to this repo with `apps/web` as the Root Directory.
- The target database exists and is reachable from the deployment environment.
- The target database has a recent backup or snapshot if the release includes schema changes.
- Google Cloud OAuth credentials exist for the deployed domain.
- You have access to the Telegram bot token and can call the Telegram Bot API.

## Required environment variables

Set these in the Vercel project for the target environment before deploying:

- `DATABASE_URL`
- `APP_BASE_URL`
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ALLOWED_USER_IDS`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_LINK_TOKEN_SECRET`
- `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`
- `CRON_SECRET`

## Environment notes

- `APP_BASE_URL` must be the canonical public app origin for that environment.
- `GOOGLE_OAUTH_REDIRECT_URI` must exactly match the deployed callback URL and the Google Cloud OAuth client configuration.
- `GOOGLE_LINK_TOKEN_SECRET`, `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`, and `CRON_SECRET` should be unique per environment.
- `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY` must be a base64-encoded 32-byte key.
- `TELEGRAM_ALLOWED_USER_IDS` is required in all environments. The app should not boot without it.
- Vercel Preview and Vercel Production must use different `DATABASE_URL` values. Preview must not point at the production database.

## GitHub Actions migration secret

Set the production database connection string in GitHub Actions secrets as `DATABASE_URL_PRODUCTION`.

- This secret is for the hosted migration workflow, not for Vercel runtime configuration.
- The migration workflow maps `DATABASE_URL_PRODUCTION` to `DATABASE_URL` only inside the job that runs `pnpm --filter @atlas/db db:check` and `pnpm --filter @atlas/db db:migrate`.
- Keep the production secret scoped to the repo or environment that owns production releases.
- In GitHub branch protection or rulesets, mark `Apply DB Migrations / apply-db-migrations` as a required status check for the production release path.

## Pre-deploy checks

1. Confirm the release branch is not `main` while implementation work is still ongoing.
2. Run the narrowest relevant verification for the release scope.
3. If shared contracts, schemas, or cross-package behavior changed, run `pnpm typecheck` and `pnpm test` if the environment supports it.
4. Confirm docs are updated for any new env vars, external surfaces, or operator steps.

## Migrations

1. Review the pending migration files under `packages/db/drizzle/`.
2. Confirm the migration set matches the code being deployed.
3. Confirm the database commands are run only through `packages/db`:
   - `cd packages/db && DATABASE_URL=... pnpm db:generate`
   - `cd packages/db && DATABASE_URL=... pnpm db:check`
   - `cd packages/db && DATABASE_URL=... pnpm db:migrate`
   - or the equivalent `pnpm --filter @atlas/db ...` form with `DATABASE_URL` already set
4. Merge the release to `main` and let [`.github/workflows/apply-db-migrations.yml`](/Users/maxlin/Code/Atlas/.github/workflows/apply-db-migrations.yml) run against `DATABASE_URL_PRODUCTION`.
5. Do not apply production migrations from a local shell. The GitHub Actions migration workflow is the only supported production migration runner.
6. Confirm the migration workflow succeeds before starting or approving the production Vercel release.
7. If the environment has known partial-state risk, verify the release migration is safe to rerun or has an explicit recovery plan.

## Deploy

1. Push the release branch and confirm the intended commit SHA.
2. Merge the intended commit to `main`.
3. Verify [`.github/workflows/apply-db-migrations.yml`](/Users/maxlin/Code/Atlas/.github/workflows/apply-db-migrations.yml) passed on that `main` commit before promoting any production deploy.
4. Verify the Vercel project uses `apps/web` as the Root Directory and can access workspace files outside that directory.
5. Confirm the target Vercel environment has all required env vars, including separate Preview and Production `DATABASE_URL` values.
6. Deploy the intended `main` commit to Vercel Production.
7. Confirm the deployment is healthy before switching any production traffic assumptions to it.

## Register or verify the Telegram webhook

If this is a new production domain or the webhook target changed, register the webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://YOUR-DEPLOYMENT-DOMAIN/api/telegram/webhook",
    "secret_token": "YOUR-TELEGRAM-WEBHOOK-SECRET",
    "allowed_updates": ["message", "edited_message"]
  }'
```

Verify the webhook status:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

## Post-deploy verification

### Telegram gate

1. Send a plain text message from an allowlisted Telegram account that is not yet linked.
2. Confirm the webhook responds successfully.
3. Confirm Atlas replies with a Google connect link.
4. Confirm no ingress record is created for that unlinked message.

### Google connect and OAuth

1. Open the Telegram-delivered Google connect link.
2. Confirm `GET /google-calendar/connect` renders the confirmation page and does not burn the handoff during preview.
3. Confirm clicking the confirmation action starts Google OAuth.
4. Complete OAuth with a real Google account allowed for the configured Google Cloud project.
5. Confirm the callback lands on the HTML success page.
6. Confirm a linked connection record exists and that stored credentials are encrypted at rest.
7. Confirm a follow-up Telegram message from the linked user now goes through normal ingress, planning, and scheduling flow.

### Cron protection

1. Confirm the GitHub Actions workflows [`.github/workflows/send-followups.yml`](/Users/maxlin/Code/Atlas/.github/workflows/send-followups.yml) and [`.github/workflows/reconcile-google-calendar.yml`](/Users/maxlin/Code/Atlas/.github/workflows/reconcile-google-calendar.yml) are enabled with `APP_BASE_URL` and `CRON_SECRET` repository secrets.
2. Confirm `send-followups.yml` runs every 15 minutes and `reconcile-google-calendar.yml` runs every 30 minutes.
3. Confirm both workflows expose manual `workflow_dispatch` for smoke tests.
4. Call the follow-up cron route without `Authorization: Bearer $CRON_SECRET` and confirm it is rejected.
5. Call the follow-up cron route with the correct bearer token and confirm it succeeds.
6. Call the reconcile route without `Authorization: Bearer $CRON_SECRET` and confirm it is rejected.
7. Call the reconcile route with the correct bearer token and confirm it succeeds.

### Basic safety checks

1. Confirm removed public planner/debug routes are still unavailable.
2. Confirm linked-account reads do not expose raw Google access or refresh tokens.
3. Confirm Vercel logs do not expose webhook secrets, cron secrets, link tokens, or decrypted Google credentials.
4. Confirm the production deploy commit has a successful `apply-db-migrations` GitHub Actions run attached to it.

## Rollback notes

- If the app deploy is bad but the schema is still compatible, roll traffic back to the last known good deployment.
- If a migration is not backward-compatible, do not assume app rollback alone is sufficient.
- If the migration workflow fails, do not continue with production deploy until the workflow is fixed or the migration issue is explicitly recovered.
- If Google OAuth is failing after deploy, first verify `APP_BASE_URL`, `GOOGLE_OAUTH_REDIRECT_URI`, and the Google Cloud OAuth client configuration all match exactly.
- If Telegram delivery fails after deploy, verify webhook registration, secret-token alignment, and Vercel route health before changing app code.

## Related docs

- `README.md`
- `docs/workflows/vercel-telegram-webhook.md`
- `docs/workflows/feature-delivery.md`
- `docs/decisions/0007-google-calendar-authority-and-sync.md`
- `docs/decisions/0008-security-lockdown-and-google-oauth-handoff.md`
