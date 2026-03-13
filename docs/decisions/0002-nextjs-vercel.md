# ADR 0002: Next.js on Vercel

## Status

Accepted

## Context

The MVP needs Telegram webhooks, cron-triggered reminder dispatch, and a small internal admin surface. Vercel fits the intended deployment model and Next.js provides a single app container for routes and internal pages.

## Decision

Use Next.js as the only deployable app in `apps/web` and target Vercel-compatible route handlers.

## Consequences

- The repo gets a lightweight internal UI without introducing a separate frontend app.
- Business logic must stay outside Next.js route handlers to avoid framework lock-in.

