# ADR 0008: Security lockdown and Google OAuth handoff

## Status

Accepted

## Context

Atlas now exposes real scheduling behavior through Telegram and Google Calendar. That makes public surface area, credential handling, and route ownership security-critical rather than optional cleanup work.

We need one durable rule for:

- which routes may remain externally reachable
- how Google Calendar linking starts from Telegram without a bearer-style user token in a public OAuth-start URL
- how Google credentials are stored and read
- how long sensitive operational records should live

## Decision

Use a minimal public surface and a session-based Google link handoff.

- Publicly reachable routes are limited to:
  - Telegram webhook
  - Google connect handoff route
  - Google OAuth start/callback
  - cron routes protected by `Authorization: Bearer $CRON_SECRET`
- Internal planner/debug mutation routes are removed rather than merely hidden.
- Google linking starts from a one-time Telegram-to-browser handoff token signed with `GOOGLE_LINK_TOKEN_SECRET`.
- The handoff route validates and consumes that token, creates a short-lived server-side link session, sets an `HttpOnly` cookie, and redirects to OAuth start.
- OAuth start derives the Atlas user from the server-side link session only.
- Google access and refresh tokens are encrypted at rest with a dedicated token-encryption key.
- Normal linked-account reads return redacted metadata only; raw credentials are available only to the runtime path that constructs the Google adapter.
- Security domains stay separate:
  - `TELEGRAM_WEBHOOK_SECRET` for webhook verification only
  - `CRON_SECRET` for cron auth only
  - `GOOGLE_LINK_TOKEN_SECRET` for Google handoff signing only
  - token-encryption key for credential encryption only
- Operational security records such as OAuth states, handoffs, and link sessions are short-lived and should be purged aggressively.

## Consequences

- Atlas reduces accidental internet-reachable mutation/debug entrypoints.
- Google account linking no longer relies on a reusable user-binding token on the OAuth-start URL.
- A database read compromise is materially less useful because Google tokens are encrypted at rest.
- Admin/debug tooling must operate on redacted linkage metadata, not raw credentials.
- Reconciliation now also acts as the bounded maintenance path for expiring OAuth/link artifacts and scrubbing revoked credentials.

## Guardrails

- Do not reintroduce public planner/debug routes without explicit architecture review.
- Do not reuse secrets across webhook, cron, handoff, or encryption domains.
- Do not expose raw Google credentials in responses, logs, planner runs, cron payloads, or admin/debug surfaces.
- Do not keep OAuth states, handoffs, or link sessions longer than operationally necessary.
