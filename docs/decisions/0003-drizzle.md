# ADR 0003: Drizzle ORM for Postgres

## Status

Accepted

## Context

The product needs a relational schema, migration flow, and typed repositories, while staying close to SQL for auditability and long-term maintainability.

## Decision

Use Drizzle ORM and Drizzle Kit in `packages/db` for schema and migration management.

## Consequences

- Queries remain explicit and readable.
- The team avoids scattering raw SQL and schema definitions across the app.

