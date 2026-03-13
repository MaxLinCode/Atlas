# Architecture Docs

This directory holds durable technical structure docs for Atlas.

## Files

- `data-model-boundaries.md`: canonical vs operational vs deferred records for MVP data ownership
- `ai-context-model.md`: structured memory and prompt-context design for AI input and output flows
- `component-contracts.md`: allowed inputs, outputs, and mutations for each major component
- `system-boundaries.md`: ownership and responsibility boundaries across the stack

## Boundaries

- Keep product scope in `docs/product/`.
- Keep quick project-wide architecture context in `docs/architecture.md`.
- Record irreversible architectural decisions in `docs/decisions/`.
- Use this directory for focused architecture topics that need more precision than the top-level overview.
