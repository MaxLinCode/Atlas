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

Prompt iteration loop:

1. Start with the narrowest failing eval for the touched prompt path.
2. If the eval fails, inspect:
   - the suite report under `packages/integrations/*.manual-eval-report.json`
   - the generated prompt-improvement brief under `packages/integrations/*.prompt-improvement.md`
3. Use the prompt-improvement brief as a starting point, not as authority:
   - preserve the owning prompt's original role and contract
   - prefer the smallest prompt edit that addresses the failure pattern
   - do not weaken schema validation or runtime safety to make an eval pass
4. Rerun the same targeted eval after each prompt change until the suite passes or a non-prompt issue becomes clear.
5. After the targeted suite passes, run `pnpm eval:all` before finishing so the full prompt surface is revalidated together.

Meta-prompt intent for generated prompt-improvement briefs:

- diagnose why the current prompt failed
- identify the smallest generalizable change
- rewrite the full prompt, not just a patch fragment
- avoid overfitting to one failure string
- preserve the original product intent and safety boundary

Use the generated brief to speed iteration, but always verify the actual prompt diff and resulting eval output yourself.

Do not treat passing live evals as a substitute for deterministic tests. Use evals for prompt quality and contract tests for runtime safety.
