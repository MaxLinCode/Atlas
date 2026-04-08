# Deterministic Mutation Executor — Handoff

## Branch & Worktree

- **Worktree:** `.worktrees/atlas-mutation-executor-plan`
- **Branch:** `claude/mutation-executor-plan`
- **Base:** `9c0a4c8` (main at time of branch)
- **Head:** `ebc8e32`

## Plan File

`docs/superpowers/plans/2026-04-05-deterministic-mutation-executor.md`

Use `superpowers:subagent-driven-development` (or `superpowers:executing-plans`) to continue.

## Completed Tasks (7/13)

| # | Task | Commit |
|---|------|--------|
| 1 | Define `MutationResult` type in `@atlas/core` | `2a591f0` |
| 2 | Schema changes — `urgency` + `operationKind` | `a41193d` |
| 3 | Extract calendar helpers to `calendar-scheduling.ts` | `863d3f1` |
| 4 | Extract ambiguous-title helpers to `ambiguous-title.ts` | `1629ffe` |
| 6 | Proposal rehydration — `rehydratePendingWriteFromProposal` | `ce56db9` |
| 5 | Policy simplification — remove `recover_and_execute` | `dc7f4dc` |
| 7 | Drop `plannerRun` from store inputs, `ProcessedInboxResult` → `MutationResult` | `ebc8e32` |

## Remaining Tasks (6/13)

| # | Task | Dependencies |
|---|------|-------------|
| 8 | Build `executePendingWrite` orchestrator | 1, 3, 4, 7 (all done) |
| 9 | Update `mutation-reply.ts` to accept `MutationResult` | 1, 7 (all done) |
| 10 | Update `conversation-state.ts` to consume `MutationResult` | 1, 7 (all done) |
| 11 | Webhook wiring — collapse mutation branches | 5, 8, 9, 10 |
| 12 | Delete obsolete modules | all above |
| 13 | Final verification and cleanup | 12 |

Tasks 8, 9, and 10 have no remaining blockers and could be done in any order (though 8 is the largest). Task 11 depends on 8, 9, 10.

## Current Type Error State

`pnpm --filter @atlas/db typecheck` — passes
`pnpm --filter @atlas/core typecheck` — 1 pre-existing error in `write-commit.ts` (unrelated)
`pnpm --filter @atlas/web typecheck` — ~17 errors, all expected:

- **`telegram-webhook.ts`**: References `recover_and_execute` (3 errors), `plannerRun` in store calls (3 errors) → Task 11
- **`turn-router.ts` + `turn-router.test.ts`**: References `recover_and_execute` and `mutationInputSource` (5 errors) → Task 11
- **`rehydrate-proposal.ts` + test**: Minor type mismatches in test fixtures (`time.kind` missing, `null` vs `undefined`) → fix during Task 8 or 11
- **`write-commit.ts`**: Pre-existing, unrelated

## Key Files Created/Modified

### New files
| File | Purpose |
|------|---------|
| `packages/core/src/mutation-result.ts` | `MutationResult` discriminated union type |
| `apps/web/src/lib/server/calendar-scheduling.ts` | Extracted calendar helpers |
| `apps/web/src/lib/server/ambiguous-title.ts` | Extracted ambiguous-title helpers |
| `apps/web/src/lib/server/rehydrate-proposal.ts` | Proposal → PendingWriteOperation rehydration |

### Modified files
| File | Change |
|------|--------|
| `packages/core/src/index.ts` | Export MutationResult, add operationKind to proposal entity, remove recover_and_execute/mutationInputSource from schemas |
| `packages/core/src/discourse-state.ts` | Add urgency to taskFields |
| `packages/db/src/planner.ts` | Remove plannerRun from store inputs, return MutationResult, delete ProcessedInboxResult type |
| `apps/web/src/lib/server/decide-turn-policy.ts` | Confirmations rehydrate proposal and produce execute_mutation |
| `apps/web/src/lib/server/process-inbox-item.ts` | Imports from extracted modules (will be deleted in Task 12) |

## Notes

- Task 8 (build `executePendingWrite`) is the largest remaining task — it's the core executor with ~400 lines and tests for all operation kinds. The plan has complete code for it.
- Tasks 9 and 10 are small mechanical updates (change import types, rename discriminants in switch cases).
- Task 11 (webhook wiring) is the integration point — collapsing two mutation branches into one.
- Task 12 deletes `process-inbox-item.ts`, the planner LLM prompt, and `synthesize-mutation-text.ts`.
- The `rehydrate-proposal.test.ts` has minor type errors (time spec needs `kind: "absolute"`, targetRef uses `null` where schema expects `undefined`). These should be fixed when touched.
