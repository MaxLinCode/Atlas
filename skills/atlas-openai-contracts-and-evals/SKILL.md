---
name: atlas-openai-contracts-and-evals
description: Update Atlas prompts, structured OpenAI outputs, output schemas, or live eval fixtures while preserving validated contracts. Use when Codex edits prompt assets, response parsing, schema validation, eval suites, or model-facing output requirements in Atlas.
---

# Atlas OpenAI Contracts And Evals

Read `docs/current-work.md` first. Atlas is actively hardening prompt assets, eval coverage, and model-output boundaries.

Work with these rules:

- Keep prompts and external API client code in `packages/integrations`.
- Keep app-owned schemas and product contracts in `packages/core` or the application layer that validates them.
- Validate structured outputs at the boundary before downstream mutation or reply logic uses them.
- Treat prompt changes as behavior changes when they can alter routing, mutation readiness, scheduling interpretation, or confirmation handling.

When editing:

1. Identify the owning prompt, schema, parser, and runtime caller together.
2. Update the output contract and parser in the same change when the model shape changes.
3. Update or add the matching tests and eval fixtures.
4. Prefer targeted eval commands over broad manual runs:
   - `pnpm eval:turn-router`
   - `pnpm eval:router-confirmation`
   - `pnpm eval:planner`
   - `pnpm eval:confirmed-mutation-recovery`
   - `pnpm eval:conversation-context`

Do not treat passing live evals as a substitute for deterministic tests. Use evals for prompt quality and contract tests for runtime safety.
