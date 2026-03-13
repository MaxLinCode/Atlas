# Vercel Telegram Webhook Deployment

## Purpose

Use this workflow to deploy the Atlas webhook route to Vercel and connect a Telegram bot to the deployed HTTPS endpoint for a real smoke test.

## Preconditions

- The Vercel project points at this repository with `apps/web` as the Next.js app.
- The database and migrations are configured for the target environment.
- You have a Telegram bot token and can call the Telegram Bot API.

## Required environment variables

Set these in the Vercel project for the target environment before deploying:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

## Route expectations

- The Telegram webhook endpoint is `POST /api/telegram/webhook`.
- The route expects the `x-telegram-bot-api-secret-token` header to exactly match `TELEGRAM_WEBHOOK_SECRET`.
- The route is intended for dynamic Node.js execution on Vercel and should not be cached.

## Deploy

1. Connect the repo to a new Vercel project.
2. Set the framework to Next.js.
3. Set the Root Directory to `apps/web`.
4. Enable the Vercel setting that allows the build to access workspace files outside the Root Directory if Vercel does not detect it automatically.
5. Add the required environment variables in Vercel for Preview or Production.
6. Deploy the latest `main` commit.

## Register the Telegram webhook

After Vercel gives you a deployment URL, register the webhook with Telegram using the deployed HTTPS route and the same secret stored in Vercel.

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://YOUR-DEPLOYMENT-DOMAIN/api/telegram/webhook",
    "secret_token": "YOUR-TELEGRAM-WEBHOOK-SECRET",
    "allowed_updates": ["message", "edited_message"]
  }'
```

Confirm Telegram accepted the webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

## Smoke test

1. Send a plain text message to the Telegram bot.
2. Verify the Vercel function returns HTTP 200 for the delivery.
3. Confirm the response body includes `accepted: true`.
4. Confirm duplicate redelivery of the same Telegram `update_id` returns `duplicate: true`.
5. Confirm invalid or missing secret headers return HTTP 401 without persisting ingress state.

## Notes

- Do not log the webhook secret in Vercel function logs or error output.
- Keep the route handler thin and continue moving persistence and planning behavior into workspace packages.
- After the first Vercel smoke test, the next backend milestone is replacing the in-memory `bot_events` store with a real Drizzle-backed repository and persisting accepted messages as `inbox_items`.
