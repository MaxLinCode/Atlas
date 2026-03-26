# Architecture Pass: Turn-Routing Pipeline Refactor

## 1. Is the seam design clean?

**Yes, with one clarification needed on the stage-2/commit boundary.**

`classifyTurn → interpretWriteTurn → commit → policy` is structurally cleaner than the current pipeline for two concrete reasons:

**Current inversion:** `resolveWriteContract` runs before extraction to scope which slots to extract. This is architecturally backwards — the contract prerequisite is derived from partial understanding (just the turn type), then used to gate the full understanding call. If the inversion produces the wrong contract, slot extraction is mis-scoped from the start.

**Current fragmentation:** Two separate LLM calls (contract derivation + slot extraction) both read the same user turn to understand intent. They're not informationally independent — a slot extractor that knows what kind of write is happening would extract better. Merging them into `interpretWriteTurn` fixes this.

The one concern: the current `llm-classifier.ts` is doing entity resolution inside classification (`resolvedEntityIds` comes back with the turn type). In the new shape, entity resolution belongs in stage 2 (`interpretWriteTurn`), not stage 1. Classification should produce a turn type and confidence only. If entity resolution stays in stage 1, it leaks interpretation logic into a routing step.

---

## 2. What should stage-2 output contain?

Stage-2 output is the **turn-scoped interpretation** — what did the user express in this message:

```
WriteInterpretation {
  operationKind: "plan" | "edit" | "reschedule" | "complete" | "archive" | ...
  targetRef: { entityId?: string; description?: string } | null
  taskName: string | null
  fields: {
    scheduleFields?: { day?, time?, duration? }
    taskFields?: { priority?, label?, sourceText? }
    // additional field groups as the operation set grows
  }
  sourceText: string      // the originating user utterance
  confidence: Record<string, number>
  unresolvedFields: string[]
}
```

One addition worth making:

- **`actionDomain`**: what type of entity is being operated on (`task`, `schedule_block`, etc.). Without this, commit has to infer it from operationKind, which creates coupling.

Write readiness is not part of this seam. It emerges naturally when policy evaluates the resolved `PendingWriteOperation` — specifically whether `missingFields` is empty and whether the operation kind requires consent. Stage-2 describes what the user said; policy decides what to do about it.

---

## 3. What belongs in PendingWriteOperation vs stage-2 output?

The key principle: **stage-2 output is turn-scoped; PendingWriteOperation is workflow-scoped.**

The trap to avoid: if PendingWriteOperation just mirrors stage-2 output with some fields marked "committed", they collapse into the same thing. The distinction has to be structural:

| Stage-2 output | PendingWriteOperation |
|---|---|
| raw interpretation of this turn | committed state across all turns in this workflow |
| includes confidence scores per field | confidence scores don't belong here — commit resolved them |
| includes unresolvedFields (what this turn couldn't determine) | includes missingFields (what the workflow still needs to execute) |
| includes sourceText of this turn | includes originatingText of the *first* turn that started the workflow |
| ephemeral, per-turn | persisted across turns in discourse state |

PendingWriteOperation shape:

```
PendingWriteOperation {
  operationKind: "plan" | "edit" | "reschedule" | ...
  targetRef: ResolvedEntityRef | null
  resolvedFields: {
    scheduleFields?: { day?, time?, duration? }
    taskFields?: { priority?, label?, sourceText? }
    // mirrors the field group structure from WriteInterpretation
  }
  missingFields: string[]   // flat list of dot-paths, e.g. "scheduleFields.time"
  originatingText: string
  startedAt: string
}
```

What it should NOT contain:
- Per-field confidence scores (commit evaluated them, they're ephemeral)
- The stage-2 output verbatim (that creates the second-interpretation-object problem)
- Proposal content (proposals are separate entities in the entity registry)

The key guard: if you find yourself copying fields from `WriteInterpretation` directly into `PendingWriteOperation` without a commit gate, the two concepts have collapsed.

---

## 4. Where should contract derivation live?

Move it into commit. Currently contract derivation is pre-extraction — the contract gates what gets extracted. In the new shape:

- Stage-2 interprets freely, including `operationKind`
- Commit derives required fields from `operationKind` (this is the contract logic), then validates stage-2 output against it
- PendingWriteOperation is the output of commit: it carries only what passed the gate

This is better because the "contract" is now a function of understood intent, not a precondition that constrains understanding. The commit step becomes: *given what was interpreted and what was already committed, what can be carried forward and what's still missing?*

The existing `applyCommitPolicy` logic (confidence thresholds, correction detection) belongs here. It just needs to operate over the grouped field structure from `WriteInterpretation` rather than the current flat `SlotKey[]`.

---

## 5. Which modules survive, get renamed, and which boundaries move?

**Survives as-is:**
- `llm-classifier.ts` — the classification logic and fast-exits are clean. One change: strip entity resolution out of the classifier output, move that to stage-2.
- `decide-turn-policy.ts` — the policy decision tree is structurally correct. Its inputs change (it receives PendingWriteOperation instead of WriteContract + ResolvedSlots) but the logic is sound.

**Survives with changes:**
- `commit-policy.ts` — rename to `commit.ts` or `write-commit.ts`. Replace the flat `SlotKey[]` model with evaluation over grouped fields from `WriteInterpretation`. Contract derivation logic moves here from wherever it currently lives.
- `discourse-state.ts` — replace the `resolved_slots` + `pending_write_contract` pair with a single `pending_write_operation` field. The `WriteContract` schema retires; `PendingWriteOperation` takes its place.

**Gets absorbed/retired:**
- `slot-extractor.ts` (the prompt) — absorbed into the `interpretWriteTurn` prompt. No longer a standalone stage.
- `turn-router.ts` (the prompt) — uses a 4-route taxonomy (`conversation/mutation/conversation_then_mutation/confirmed_mutation`) while `llm-classifier.ts` uses a richer taxonomy. These appear to be different abstraction levels. In the new shape, classification should produce the richer turn types directly — the 4-route taxonomy was a lower-resolution precursor.

**Boundary moves:**
- Entity resolution moves from `llm-classifier.ts` → `interpretWriteTurn` (stage-2). Classification should be stateless and entity-agnostic; resolution is a write-path concern.
- Contract derivation moves from pre-extraction → inside commit.
- `conversation-state.ts` (apps/web) — the persistence logic needs to write PendingWriteOperation into discourse state instead of the current separate slots + contract fields.

---

## 6. Architectural traps

**Stage-2 becoming policy-heavy.** The clearest signal: if `interpretWriteTurn` produces a field called `shouldAsk`, `isComplete`, `readinessLevel`, or similar. Stage-2's job is description, not judgment. The direction/action (`plan` vs `edit`) is interpretation; whether that action can proceed is policy. The line to hold: stage-2 describes what the user said; commit determines what's safe to carry forward; policy determines what to do next.

**PendingWriteOperation becoming a second interpretation object.** This happens if the commit step doesn't actually gate anything — if it just copies interpretation output into PendingWriteOperation. The commit gate must have teeth: low-confidence fields should not make it into resolvedFields. If PendingWriteOperation ends up carrying confidence scores and unresolvedFields, it has collapsed back into stage-2 output.

**Entity resolution locked to task entities.** The current `target` slot is a string (entity ID or description), which is generic. The risk is that if stage-2 produces a `targetRef` modeled as `{ taskId: string }`, it can't represent schedule blocks, reminders, or other entity types. Model it as `{ entityId?: string; description?: string; entityKind?: string }` — let the mutation pipeline resolve the actual entity type.

**The gating condition between classify and interpret.** Stage-2 only runs for write-path turns. The gating logic needs to be explicit about what "write-path" means in the richer taxonomy — `planning_request`, `edit_request`, `clarification_answer` (when there's an active write workflow), `confirmation`. If gating is too loose, stage-2 runs for informational turns. If too tight, clarification answers that advance a write workflow don't get interpreted.

**Prior state injection in commit.** The current `applyCommitPolicy` takes `priorResolvedSlots` and `activeContract` as inputs. In the new shape, commit takes the current `PendingWriteOperation` (if any) as prior state. The commit step needs to know when a new interpretation represents a topic change vs an accumulation. Currently this is handled by `contractChanged` (comparing `intentKind`). In the new shape, compare `operationKind` and `targetRef` — if either changes, prior `resolvedFields` should be cleared.

---

## Recommended migration phases

**Phase 1 — Schema rename + enrichment (no behavior change)**
- Replace `WriteContract` with `PendingWriteOperation` schema in `packages/core`
- Expand intentKind to a richer operationKind
- Add targetRef, resolvedFields (rename from resolved_slots), originatingText, missingFields
- Update discourse state schema to use single `pending_write_operation` field
- All existing code adapts to new field names but behavior is unchanged

**Phase 2 — Merge interpretation into one call**
- Write new `interpretWriteTurn` prompt that unifies field extraction + operation inference + metadata into grouped `fields` output
- Update commit step to accept `WriteInterpretation` input with grouped fields (replacing flat slot model)
- Move contract derivation into commit (derive required fields from operationKind)
- Retire standalone slot-extractor call

**Phase 3 — Move entity resolution out of classify**
- Remove `resolvedEntityIds` from `TurnClassifierOutput`
- Have `interpretWriteTurn` produce `targetRef`
- Update `decideTurnPolicy` to read entity reference from PendingWriteOperation, not classification output
- Update fast-exit confirmation path (currently uses `resolvedEntityIds` from classifier)

**Phase 4 — Conversation state**
- Update `conversation-state.ts` to write PendingWriteOperation instead of separate resolved_slots + contract
- Retire `derivePersistableClarificationSlots` (this filtering was a workaround for the narrow flat-slot model)

Phases are ordered to keep each step independently deployable. Phase 1 is pure schema migration and is the lowest-risk starting point. Phase 2 is the highest-value change (eliminating the two-call fragmentation) and should be done before Phase 3.
