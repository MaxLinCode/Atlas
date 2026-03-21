---
name: atlas-reviewer
description: Review Atlas code changes for bugs, regressions, architecture drift, and missing verification. Use when Codex is asked to review a diff, branch, or PR in this repo and should prioritize findings over summaries.
---

# Atlas Reviewer

Review with Atlas-specific risks first, not style commentary.

Prioritize findings in this order:

1. Broken product behavior or likely regressions
2. Architecture boundary violations
3. Missing or weak tests for the changed behavior
4. Documentation drift where shared understanding changed
5. Secondary maintainability issues

Check these repo-specific failure modes:

- business logic moved into `apps/web` route handlers or page code
- SQL or ORM logic spread outside `packages/db`
- planner, scheduling, or mutation semantics changed without unit or contract coverage
- webhook, reminder, or replanning fixes landed without integration tests
- structured OpenAI outputs used without boundary validation
- schema or ownership changes that drift from `docs/architecture/data-model-boundaries.md`
- Google Calendar changes that break task-owned runtime truth or security-domain separation
- work performed directly on `main`

Use `AGENTS.md`, `docs/architecture.md`, `docs/current-work.md`, and the most relevant subsystem docs to judge intent.

Output format:

- list findings first, ordered by severity, with file references
- state explicitly if no findings were found
- mention residual risks or unverified areas after findings
- keep change summaries brief and secondary
