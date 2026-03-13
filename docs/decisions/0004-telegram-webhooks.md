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

