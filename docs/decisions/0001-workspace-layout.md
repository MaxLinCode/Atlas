# ADR 0001: Lean workspace layout

## Status

Accepted

## Context

Atlas needs clear seams for app delivery, persistence, and external integrations, but the MVP is still a single-user product with a narrow feature set. A package split that is too fine-grained too early adds ceremony before the behavior is proven.

## Decision

Use a pnpm workspace with one deployable app in `apps/web` and three supporting packages: `packages/core`, `packages/db`, and `packages/integrations`.

## Consequences

- The MVP stays easier to navigate because most product logic lives in one cohesive package.
- Future package extraction is still additive if planning or scheduling complexity grows later.
- Route code stays thin because app and package seams remain explicit.
