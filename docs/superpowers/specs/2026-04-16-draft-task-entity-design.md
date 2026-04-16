# Draft Task Entity for Multi-Turn Write Workflows

**Date:** 2026-04-16
**Status:** Approved
**Relates to:** [Bug: Clarification answer resets write workflow](../../bugs/2026-04-08-clarification-workflow-reset.md)

## Problem

When a user starts a new task via clarification ("Schedule gym tomorrow" -> "What time?" -> "10am"), the write pipeline loses accumulated fields and treats the answer as a new workflow. The root cause: no task entity exists in the entity registry until after mutation, so the clarification entity's `parentTargetRef` is `null`, and `resolveWriteTarget` returns the clarification entity ID as the write target. `applyWriteCommit` sees a target mismatch and wipes prior fields.

PR #85 added generic `parentTargetRef` resolution, which fixes the bug for existing-task edits. But for new tasks, there is nothing for `parentTargetRef` to point at.

## Solution

Introduce a `draft_task` entity kind in the conversation entity registry. Any time a user initiates a new planning operation (`operationKind === "plan"`, `targetRef === null`), a `draft_task` entity is created to represent the intent before the task is persisted to the database. Clarification entities point their `parentTargetRef` at the draft, and the persisted `pending_write_operation.targetRef` is patched to reference it. This allows `applyWriteCommit` to see matching targets across turns and accumulate fields correctly.

## Design

### Schema

Add `draft_task` to the entity discriminated union in `packages/core/src/index.ts`:

```typescript
export const conversationDraftTaskEntitySchema = conversationEntityBaseSchema.extend({
  kind: z.literal("draft_task"),
  data: z.object({
    operationKind: operationKindSchema,
    taskName: z.string().nullable(),
    resolvedFields: resolvedFieldsSchema,
    originatingText: z.string().min(1),
  }),
});
```

Add to `conversationEntitySchema` discriminated union and `ConversationEntity` type.

Supporting changes:
- `getParentEntityId` in `turn-router.ts`: add `"draft_task"` case returning `undefined` (drafts are targets, not references)
- `entityKey` in `conversation-state.ts`: add `"draft_task"` case keyed by entity ID (no DB `taskId` to key on)

### Creation trigger

In `deriveConversationReplyState`, after existing entity sync and before the clarification block:

**Condition:** `policy.resolvedOperation` exists, `operationKind === "plan"`, and `targetRef` is `null`.

**Behavior:**
1. If a `draft_task` entity already exists in the registry (prior turn in same workflow), update its `resolvedFields` and `taskName` from the latest `resolvedOperation`.
2. Otherwise, create a new `draft_task` via `buildConversationEntity`.
3. Store the draft entity ID for use by the clarification block.

### parentTargetRef wiring

In the clarification block (~line 131 of `conversation-state.ts`), change:
```typescript
const parentTargetRef = input.policy.resolvedOperation?.targetRef ?? null;
```
to:
```typescript
const parentTargetRef = draftEntityId
  ? { entityId: draftEntityId }
  : (input.policy.resolvedOperation?.targetRef ?? null);
```

New-task clarifications always point to the draft. Existing-task clarifications still point to the real task entity.

### pending_write_operation targetRef patch

After creating or finding the draft, patch `resolvedOperation.targetRef` to `{ entityId: draftEntityId }` before it is stored as `pending_write_operation` in discourse state (line ~194 of `conversation-state.ts`).

This ensures that on Turn 2, `applyWriteCommit` sees `priorPendingWriteOperation.targetRef = { entityId: draft-id }` matching the resolved target, so `targetChanged = false` and fields accumulate.

### Resolution flow (Turn 2)

No changes needed to `resolveWriteTarget`. Existing generic parent ref resolution handles the path:
1. Read `focus_entity_id` -> clarification entity
2. `getParentEntityId(clarification)` -> draft entity ID via `parentTargetRef`
3. Return draft entity ID as `targetEntityId`

### Promotion after mutation

In `deriveMutationState`, when a real `task` entity is created from processing results, find and supersede (`status: "superseded"`) any active `draft_task` entity in the same conversation.

### Entity context

Add `"draft_task"` case to `buildEntityContext` in `entity-context.ts`. Render with `expectedType: "draft_task"` and `taskName`/`originatingText` as label, so the LLM knows a task is being planned.

### Focus tracking

No changes. `nextFocusEntityId` is set to the clarification entity when one is created. The draft is reachable through `parentTargetRef`.

## Edge cases

1. **User pivots mid-workflow** — Different `taskName`/fields cause `applyWriteCommit` to detect `operationChanged = true`. Old draft superseded, new draft created.
2. **All fields provided on Turn 1** — Draft created then immediately superseded by real task entity in `deriveMutationState`.
3. **Edit to existing task** — `operationKind` is `"edit"` or `targetRef` is non-null. Draft creation trigger does not fire.
4. **Multiple clarification rounds** — Each turn finds the existing draft, updates `resolvedFields`. New clarifications point to the same draft.

## Testing

- Unit: `draft_task` entity created when `operationKind === "plan"` and `targetRef === null`
- Unit: `parentTargetRef` on clarification points to draft entity
- Unit: `pending_write_operation.targetRef` patched to draft entity ID
- Unit: `resolveWriteTarget` follows clarification -> draft via `parentTargetRef`
- Unit: `applyWriteCommit` accumulates fields across turns (no wipe)
- Unit: draft superseded after mutation creates real task
- Integration: full 2-turn "schedule gym tomorrow" -> "10am 30min" -> successful execution

## Files affected

| File | Change |
|------|--------|
| `packages/core/src/index.ts` | `conversationDraftTaskEntitySchema`, add to discriminated union |
| `packages/core/src/entity-context.ts` | `buildEntityContext` draft_task case |
| `apps/web/src/lib/server/conversation-state.ts` | Draft creation trigger, parentTargetRef wiring, targetRef patch, entityKey case, draft superseding in `deriveMutationState` |
| `apps/web/src/lib/server/turn-router.ts` | `getParentEntityId` draft_task case |
| `apps/web/src/lib/server/turn-router.test.ts` | New resolution tests |
| `apps/web/src/lib/server/conversation-state.test.ts` | Draft creation, parentTargetRef, targetRef patch tests |
| `packages/core/src/entity-context.test.ts` | Draft entity in LLM context |

## Secondary fix: misleading ambiguity reason

`deriveAmbiguityReason` in `turn-router.ts` falls through to "Classification confidence is too low for reliable routing" when the actual ambiguity source is missing fields. Add a missing-fields case to the reason derivation. This is cosmetic but improves debugging.
