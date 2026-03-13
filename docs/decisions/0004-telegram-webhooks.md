# ADR 0004: Telegram webhook delivery

## Status

Accepted

## Context

The MVP is production-oriented and hosted on Vercel. Webhooks align better with HTTP-first infrastructure than a long-running polling process.

## Decision

Support Telegram via webhook delivery only in v1.

## Consequences

- Route handlers need idempotency and fast acknowledgement behavior.
- Local development should simulate webhook calls instead of relying on polling loops.
- Production webhook testing and delivery require a public HTTPS endpoint, typically the Vercel deployment URL or the mapped production domain.
- Telegram webhook secrets should be configured through Vercel-managed environment secrets in deployed environments.

## Telegram webhook notes

- Keep the Telegram webhook secret only in environment-managed secret storage such as Vercel project secrets.
- Never log the Telegram webhook secret in application logs, debugging output, or error payloads.
- Future webhook hardening should include ingress idempotency, strict payload validation, and rate limiting or equivalent edge protections to reduce abuse from public internet exposure.
