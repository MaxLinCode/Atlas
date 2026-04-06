# Deterministic Mutation Executor

Replace the planner LLM (`planInboxItemWithResponses`) and `processInboxItem` orchestrator with a deterministic executor that operates directly on `pendingWriteOperation`.

## Problem

The current mutation pipeline has a redundant LLM call. `interpretWriteTurn` + `applyWriteCommit` already resolve the user's intent, target entity, and schedule fields into a structured `pendingWriteOperation`. But when it's time to execute, `processInboxItem` calls `planInboxItemWithResponses` — a separate LLM that re-derives all of this from raw text. The `synthesizeMutationText` step even un-structures the resolved fields back into natural language just so the planner can re-parse them.

This causes wrong-entity references, wasted tokens, and added latency. The planner is fully redundant.

## Design

### Approach

Approach B: executor lives in `apps/web`, pure logic stays in `packages/core`.

`executePendingWrite` is an orchestrator in `apps/web/src/lib/server/` that takes a `PendingWriteOperation` plus store/calendar context and deterministically produces a `MutationResult`. No LLM involved.

### `MutationResult` type

Defined in `packages/core`. Replaces `ProcessedInboxResult`.

```ts
type MutationResult =
  | { outcome: "created"; tasks: Task[]; scheduleBlocks: ScheduleBlock[]; followUpMessage: string }
  | { outcome: "scheduled"; tasks: Task[]; scheduleBlocks: ScheduleBlock[]; followUpMessage: string }
  | { outcome: "rescheduled"; updatedBlock: ScheduleBlock; followUpMessage: string }
  | { outcome: "completed"; tasks: Task[]; followUpMessage: string }
  | { outcome: "archived"; tasks: Task[]; followUpMessage: string }
  | { outcome: "needs_clarification"; reason: string; followUpMessage: string };
```

Outcome maps from `operationKind`: plan (new task) -> created, plan (existing task) -> scheduled, reschedule -> rescheduled, complete -> completed, archive -> archived.

### Executor: `executePendingWrite`

Location: `apps/web/src/lib/server/execute-pending-write.ts`

Input:

```ts
type ExecutePendingWriteInput = {
  pendingWriteOperation: PendingWriteOperation;
  userId: string;
  tasks: Task[];
  scheduleBlocks: ScheduleBlock[];
  userProfile: UserProfile;
  calendar: ExternalCalendarAdapter | null;
  googleCalendarConnection: GoogleCalendarConnection | null;
};
```

Switches on `operationKind`:

- **`plan`** with `targetRef.entityId` null: new task. Title from `targetRef.description`. Priority/urgency from `resolvedFields.taskFields`. Schedule from `resolvedFields.scheduleFields` via `buildScheduleProposal`. Write to calendar via `scheduleTaskWithCalendar`. Return `outcome: "created"`.
- **`plan`** with `targetRef.entityId` present: schedule existing task. Look up task by entity ID, check ambiguous titles, build schedule proposal, write to calendar. Return `outcome: "scheduled"`.
- **`reschedule`**: look up schedule block by `targetRef.entityId` (task ID) from context blocks. Calendar drift detection, `buildScheduleAdjustment`, update calendar event. Return `outcome: "rescheduled"`.
- **`complete`**: resolve task from `targetRef.entityId`, check ambiguous titles. Return `outcome: "completed"`.
- **`archive`**: same as complete. Return `outcome: "archived"`.
- **`edit`**: deferred. Executor switch has a branch that returns `needs_clarification` for now, keeping the seam open for future implementation.

Any branch that can't proceed (missing calendar, ambiguous target, unresolvable entity) returns `outcome: "needs_clarification"`.

### Extracted calendar helpers

Move from `process-inbox-item.ts` into `apps/web/src/lib/server/calendar-scheduling.ts`:

- `scheduleTaskWithCalendar` — calendar event create/update with drift detection and logging
- `buildRuntimeScheduleBlocks` — merge Atlas blocks with Google Calendar busy periods
- `filterBusyPeriodsAgainstAtlasTasks`
- Calendar logging helpers (`logCalendarWriteAttempt`, `logCalendarWriteSuccess`, `logCalendarWriteFailure`)
- Ambiguous title detection helpers (`hasAmbiguousTaskTitle`, `hasAmbiguousScheduledTitle`, `findActionableTasksWithSameTitle`, `buildAmbiguousTaskReply`)

### Policy simplification

`recover_and_execute` is removed from `TurnPolicyAction`. Confirmations that resolve a proposal now produce `execute_mutation`. The distinction between direct writes and confirmed proposals is no longer meaningful — both execute `pendingWriteOperation`.

Removed fields:
- `mutationInputSource` from `TurnPolicyDecision`
- `recover_and_execute` from the action enum

### Proposal confirmation and `pendingWriteOperation` rehydration

When a user confirms a proposal, `pending_write_operation` on discourse state may not match the proposal being confirmed (e.g., the user started a different workflow in between). The proposal entity's `fieldSnapshot` is the durable checkpoint.

On confirmation of a proposal, the turn router rehydrates `pending_write_operation` from the proposal entity:

1. Look up the proposal entity by `resolvedProposalId`
2. Rebuild `PendingWriteOperation` from `data.fieldSnapshot` (resolvedFields), `data.targetEntityId` (targetRef), `data.operationKind`, and `data.originatingTurnText`
3. Set as `resolvedOperation` on the policy output
4. Executor receives it like any other `pendingWriteOperation`

Schema changes to support this:
- Add `operationKind` to the proposal entity `data` (not stored today)

### Schema changes

**`resolvedFieldsSchema` (`packages/core/src/discourse-state.ts`):**
- Add `urgency` to `taskFields`: `urgency: z.enum(["low", "medium", "high"]).optional()`

**Proposal entity `data`:**
- Add `operationKind: OperationKind`

### Webhook wiring

The two mutation branches in `telegram-webhook.ts` collapse to one:

```
if (action === "execute_mutation") {
  const result = await executePendingWrite({
    pendingWriteOperation: policy.resolvedOperation,
    userId, tasks, scheduleBlocks, userProfile, calendar, googleCalendarConnection,
  });
}
```

`deriveMutationState` in `conversation-state.ts` is updated to consume `MutationResult` instead of `ProcessedInboxResult`.

### Store persistence

Reuse existing store methods (`saveTaskCaptureResult`, `saveTaskCompletionResult`, `saveScheduleRequestResult`, etc.). Drop `plannerRun` field from their input types. No new store methods needed.

## Deletions

**Modules removed:**
- `apps/web/src/lib/server/process-inbox-item.ts` and tests
- `packages/integrations/src/prompts/planner.ts`
- `packages/integrations/src/manual/planner.eval-suite.ts`
- `packages/core/src/synthesize-mutation-text.ts` and tests

**Exports removed:**
- `planInboxItemWithResponses` from `@atlas/integrations`
- `recoverConfirmedMutationWithResponses` from `@atlas/integrations`
- `ProcessedInboxResult` from `@atlas/db` (replaced by `MutationResult` in `@atlas/core`)

**Types/fields removed:**
- `recover_and_execute` from `TurnPolicyAction`
- `mutationInputSource` from `TurnPolicyDecision`
- `plannerRun` from store input types
- `ProcessInboxItemDependencies` / `ProcessInboxItemRequest`

## Testing

**New tests (`execute-pending-write.test.ts`):**
- One test per `operationKind` happy path: plan (new), plan (existing), reschedule, complete, archive
- Clarification fallbacks: missing calendar, ambiguous title, unresolvable entity
- Calendar interaction: correct times from `resolvedFields.scheduleFields`

**New tests (proposal rehydration):**
- Confirmation when `pending_write_operation` was overwritten by different workflow — verifies `fieldSnapshot` used
- Confirmation when `pending_write_operation` still matches

**Modified tests:**
- `conversation-state.test.ts` — `MutationResult` instead of `ProcessedInboxResult`, no `plannerRun`
- `decide-turn-policy.test.ts` — no `recover_and_execute`, confirmations produce `execute_mutation`
- `telegram-webhook.ts` tests — mock `executePendingWrite` instead of `processInboxItem`

**Deleted tests:**
- `process-inbox-item.test.ts`
- Planner eval suite
- `synthesizeMutationText` tests

**Unchanged:**
- Turn router, write-commit, calendar helper tests
