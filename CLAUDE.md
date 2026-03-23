# AGENTS.md

## Mission

Build Atlas as a production-quality, Telegram-first planning assistant. The codebase should stay understandable to a new contributor and safe for repeated agent-driven edits.

## Architecture rules

- `apps/web` owns delivery surfaces only: API routes, cron entrypoints, and internal admin pages.
- Business logic belongs in `packages/*`, not in route handlers or page components.
- `packages/core` is the source of truth for product concepts, validation schemas, planning behavior, and scheduling rules.
- `packages/core` must not depend on Next.js route code or page components.
- `packages/db` implements persistence and repositories; do not spread SQL or ORM calls throughout the app.
- `packages/integrations` owns external API clients and transport adapters, not product logic.

## Anti-slop guardrails

- Prefer extending an existing module before creating a new abstraction.
- Do not add a dependency without a short reason in the change summary.
- No catch-all `utils` files unless the helpers are truly cross-cutting and cohesive.
- Keep files focused. If a file starts spanning multiple responsibilities, split by behavior.
- Keep comments rare and purposeful. Explain why, not what.

## Testing rules

- Every core business rule or planning/scheduling heuristic should have a unit test.
- Every webhook, reminder, or replanning bug fix requires an integration test.
- Structured OpenAI outputs must be validated at the boundary and covered by contract tests.

## Documentation rules

- Update `README.md` when setup or core commands change.
- Update `docs/architecture.md` when dependency direction or major flow changes.
- When touching schemas, migrations, persisted records, ingestion record creation, or core data types, verify the change matches `docs/architecture/data-model-boundaries.md` and update that doc if the ownership model changes.
- Add an ADR in `docs/decisions/` for meaningful infrastructure or architecture decisions.
- Update `docs/current-work.md` when the active implementation focus changes.

## Git workflow rules

- Follow `docs/workflows/feature-delivery.md` for product features, fixes, and behavior changes.
- For any non-trivial code change, work on a feature branch named `codex/<short-description>`.
- Do not commit or push implementation work directly to `main`.
- Before pushing, confirm the current branch is not `main`.
- If work is accidentally committed on `main`, move it to a feature branch before pushing.

## Execution rules

- Before finishing, run the narrowest relevant checks for the touched code.
- For changes isolated to one package, prefer `pnpm --filter <package> typecheck` and `pnpm --filter <package> test`.
- For `apps/web` route or page changes, run `pnpm --filter @atlas/web typecheck` and the relevant app tests.
- For cross-package changes or shared type/schema changes, run `pnpm typecheck` and `pnpm test`.
- If dependencies, workspace config, Next.js config, or build tooling change, run `pnpm build`.
- In the final response, summarize which checks ran and call out anything not verified.

## Done definition

A task is complete when:

- the requested behavior exists,
- affected checks pass,
- docs are updated when setup, commands, or architecture changed,
- and any skipped verification is clearly called out.

# Turn Routing Refactor — Claude Code Handoff (v2)

## Context

The conversational scheduler's turn routing pipeline has a fundamental architectural problem: a
single deterministic pass conflates intent classification (pragmatic, context-sensitive) with slot
resolution (mechanical, schema-driven). This causes multi-turn flows to loop — clarification
answers like "5pm" and consent like "ok" fail to exit clarification state and never reach mutation.

Four specific bugs were identified before this refactor was scoped:

1. `hasClockTime` regex misses bare hours ("5", "17:00", "around 5"), leaving `time` in
   `missingSlots` and re-triggering ambiguity
2. Proposal `status` filter only matches `"active"` — presented proposals with any other status
   cause confirmation turns to fall through to `unknown`
3. `deriveClarificationAnswerMissingSlots` re-derives slot state from the current turn only;
   slots resolved in prior turns are invisible to it
4. The `clarification_answer` path in `deriveStructuredWriteReadiness` unconditionally returns
   `ready_needs_consent`, re-presenting proposals even after the user has already confirmed

These bugs share a root cause: `analyzeWriteSignals` boolean flags do double duty as both
classification signals and slot resolution checks. Fixing any one bug without the architectural
change just shifts the fragility elsewhere.

---

## Target Architecture

Three layers, in order. Each has a single responsibility and does not bleed into the others.

```
PIPELINE A — Intent classification
  Heuristic pre-filter (fast exit, narrow cases only)
  → LLM classifier (everything else)
  Output: turnType, resolvedEntityIds, resolvedProposalId, confidence
  Rule:   NO slot extraction. Pure pragmatic classification.

PIPELINE B — Slot extraction (conditional — only runs for write-intent turns)
  LLM slot extractor (semantic understanding, structured output)
  → Deterministic normalizer (canonical formatting, LLM non-determinism stops here)
  Output: extractedValues, confidence per slot, unresolvable slots
  Rule:   NO intent inference. Produces candidates only — never writes to state.

POLICY LAYER — Composition and commit
  Commit policy (decides which candidates become durable state)
  → decideTurnPolicy (routing, ambiguity, action)
  Output: TurnPolicyDecision + committedSlots
  Rule:   Single authority over what enters resolvedSlots accumulator.
          All ambiguity derived here, not embedded in either pipeline.
```

Key invariants:
- Pipeline B only runs if Pipeline A returns a turn type in `SLOT_COMMITTING_TURN_TYPES`
- Pipeline B produces candidates — the commit policy decides what gets persisted
- `DiscourseState` is never mutated inside the pipeline — caller persists `committedSlots`
- The normalizer is the state boundary — nothing below it sees raw LLM output
- Both LLM calls (classifier + extractor) are the only async boundaries

---

## Full Message Flow

```
User message arrives
  → normalize: rawText → normalizedText
  → load: discourseState, entityRegistry, active WriteContract

PIPELINE A
  → heuristic pre-filter (fast exit for exact confirmation + pure informational)
  → LLM classifier → { turnType, resolvedEntityIds, resolvedProposalId, confidence }

PIPELINE B (skip if turnType not in SLOT_COMMITTING_TURN_TYPES)
  → LLM slot extractor → { extractedValues (raw), confidence per slot, unresolvable }
  → deterministic normalizer → { extractedValues (canonical), confidence, unresolvable }

POLICY LAYER
  → commit policy → { committedSlots, needsClarification[] }
  → decideTurnPolicy → { TurnPolicyDecision, committedSlots }

Caller persists committedSlots → discourseState.resolved_slots
Action executed
```

---

## Files in Scope

```
src/
  interpretTurn.ts          — Phase 1, 3 primary target
  decideTurnPolicy.ts       — Phase 4 primary target
  (new) slotExtractor.ts    — Phase 2 deliverable: LLM extractor + normalizer
  (new) commitPolicy.ts     — Phase 2 deliverable: commit gating logic
  (new) llmClassifier.ts    — Phase 3 deliverable
```

Types live in `@atlas/core`. `DiscourseState`, `TurnInterpretation`, `TurnRoutingInput`,
`TurnPolicyDecision`, `ConversationEntity` will need additions in Phase 1.

---

## Phase Plan

---

### Phase 1 — Extend DiscourseState as the accumulator

**Goal:** Give `DiscourseState` a `resolved_slots` map and a `pending_write_contract` field.
Nothing in the routing logic changes yet. This phase is purely additive — existing behaviour
must be identical after it.

**Deliverables:**

Add to `DiscourseState` in `@atlas/core`:

```typescript
type ResolvedSlots = {
  day?: string;       // canonical: "friday", "tomorrow", "2026-03-25"
  time?: string;      // canonical 24h: "17:00"
  duration?: number;  // minutes
  target?: string;    // entityId
};

type WriteContract = {
  requiredSlots: (keyof ResolvedSlots)[];
  optionalSlots?: (keyof ResolvedSlots)[];
  intentKind: "plan" | "edit";
};

// Add to existing DiscourseState:
resolved_slots: ResolvedSlots;           // default: {}
pending_write_contract?: WriteContract;
```

Add `createEmptyDiscourseState` default values for the new fields.

Add `"presented"` and `"confirmed"` to the `ConversationEntity` proposal_option status union
(currently only `"active"` is matched in filters — this is Bug 2's root).

Add `committedSlots: ResolvedSlots` to `TurnPolicyDecision` in `@atlas/core` — the policy layer
returns this so the caller can persist without re-running any pipeline logic.

**Acceptance criteria:**
- All existing tests pass without modification
- `createEmptyDiscourseState()` returns `{ resolved_slots: {} }` with no other changes
- `TurnPolicyDecision` includes `committedSlots: ResolvedSlots`
- TypeScript compiles cleanly

---

### Phase 2 — Build the slot extractor and commit policy

**Goal:** Two new modules. `slotExtractor.ts` — an LLM-backed extractor that produces
normalized slot candidates from a turn. `commitPolicy.ts` — a pure function that decides which
candidates get durably committed to `resolvedSlots`. The old regex-based `resolveSlots` approach
is not built. `slotExtractor.ts` replaces it entirely.

---

#### Part A — LLM slot extractor (`src/slotExtractor.ts`)

The LLM's job is semantic understanding only — it returns structured primitives, never formatted
strings. The normalizer converts those primitives to canonical stored values. This boundary
ensures LLM non-determinism never reaches `resolvedSlots`.

**LLM output schema (what the model must return):**

```typescript
type RawSlotExtraction = {
  time?: { hour: number; minute: number };       // 24h, integers only
  day?: {
    kind: "relative" | "weekday" | "absolute";
    value: string;   // "tomorrow" | "friday" | "2026-03-25"
  };
  duration?: { minutes: number };
  target?: { entityId: string };
  confidence: Partial<Record<keyof ResolvedSlots, number>>;  // 0–1 per slot
  unresolvable: (keyof ResolvedSlots)[];         // explicit exit ramp — never guess
};
```

The LLM is never asked to format output. It is explicitly told: return `{ hour, minute }` not
`"5pm"`. Validate the response against this schema on receipt — malformed responses treat all
slots as `unresolvable`.

**Extractor input/output contract:**

```typescript
export type SlotExtractorInput = {
  currentTurnText: string;
  pendingSlots: (keyof ResolvedSlots)[];    // which slots are we waiting on
  priorResolvedSlots: ResolvedSlots;        // context: what's already known
  conversationContext?: string;             // recent turns for reference resolution
};

export type SlotExtractorOutput = {
  extractedValues: Partial<ResolvedSlots>;  // normalized canonical values
  confidence: Partial<Record<keyof ResolvedSlots, number>>;
  unresolvable: (keyof ResolvedSlots)[];
};

export async function extractSlots(input: SlotExtractorInput): Promise<SlotExtractorOutput>
```

**LLM prompt contract:**
- System prompt: establish scheduling context, output schema, instruction to use `unresolvable`
  rather than guess, instruction to return time as `{ hour, minute }` never a string
- Pass `pendingSlots` explicitly — the LLM should only attempt slots it was asked about
- Pass `priorResolvedSlots` — enables reference resolution ("after the standup", "same time")
- Pass `conversationContext` — recent turns so the LLM can resolve pronouns and implicit refs
- Model: fast/cheap tier — output is small and structured
- Output: JSON matching `RawSlotExtraction` exactly, no prose

**Deterministic normalizer (internal to `slotExtractor.ts`):**

Pure function, not exported. Converts `RawSlotExtraction` → `Partial<ResolvedSlots>`.
No decisions — only formatting:

```typescript
function normalize(raw: RawSlotExtraction): Partial<ResolvedSlots> {
  return {
    time: raw.time
      ? `${String(raw.time.hour).padStart(2,"0")}:${String(raw.time.minute).padStart(2,"0")}`
      : undefined,
    day: raw.day ? normalizeDay(raw.day) : undefined,
    duration: raw.duration?.minutes,
    target: raw.target?.entityId,
  };
}

function normalizeDay(day: RawSlotExtraction["day"]): string {
  if (!day) return undefined;
  if (day.kind === "absolute") return day.value;   // already ISO
  return day.value.toLowerCase();                  // "friday", "tomorrow"
}
```

The normalizer runs immediately after schema validation, before anything leaves `extractSlots`.
`SlotExtractorOutput.extractedValues` always contains canonical values — nothing downstream
sees `RawSlotExtraction`.

**Acceptance criteria:**
- `extractSlots({ currentTurnText: "after the standup", pendingSlots: ["time"], priorResolvedSlots: { day: "tomorrow" }, conversationContext: "standup is at 9:30am" })` returns `extractedValues: { time: "09:30" }`, `unresolvable: []`
- `extractSlots({ currentTurnText: "5", pendingSlots: ["time"], ... })` returns `extractedValues: { time: "17:00" }` (PM bias for scheduling context)
- `extractSlots({ currentTurnText: "whenever", pendingSlots: ["time"], ... })` returns `unresolvable: ["time"]`, `extractedValues: {}`
- Malformed LLM response (missing required fields) → all slots `unresolvable`, no throw
- Prior resolved slot survives a turn that doesn't mention it — `priorResolvedSlots` is passed
  as context but slots not in `pendingSlots` are never overwritten by the extractor
- Normalizer unit tests: `{ hour: 17, minute: 0 }` → `"17:00"`, `{ hour: 9, minute: 30 }` →
  `"09:30"`, `{ kind: "weekday", value: "Friday" }` → `"friday"` (normalizer is pure, test
  directly without LLM)

---

#### Part B — Commit policy (`src/commitPolicy.ts`)

Pure synchronous function. Single authority over what enters `resolvedSlots`. Answers four
questions for each extracted slot before committing:

1. Is this turn type allowed to commit?
2. Is confidence above threshold?
3. Is this a correction of an existing slot? (higher bar required)
4. Did the contract change? (may require reset)

```typescript
export type CommitPolicyInput = {
  turnType: TurnInterpretation["turnType"];
  extractedValues: Partial<ResolvedSlots>;
  confidence: Partial<Record<keyof ResolvedSlots, number>>;
  unresolvable: (keyof ResolvedSlots)[];
  priorResolvedSlots: ResolvedSlots;
  activeContract: WriteContract;
  priorContract?: WriteContract;            // detect contract changes
};

export type CommitPolicyOutput = {
  committedSlots: ResolvedSlots;            // merged prior + newly committed
  needsClarification: (keyof ResolvedSlots)[];  // low confidence — route to targeted re-ask
  missingSlots: (keyof ResolvedSlots)[];    // required by contract, not yet in committedSlots
};

export function applyCommitPolicy(input: CommitPolicyInput): CommitPolicyOutput
```

**Commit rules:**

```typescript
const SLOT_COMMITTING_TURN_TYPES = new Set([
  "clarification_answer",
  "planning_request",
  "edit_request",
]);

const CONFIDENCE_THRESHOLD = 0.75;
const CORRECTION_THRESHOLD = 0.9;   // higher bar for overwriting existing slot

// For each slot in extractedValues:
// 1. Skip if turnType not in SLOT_COMMITTING_TURN_TYPES → discard candidate
// 2. Skip if slot is in unresolvable → add to needsClarification
// 3. Skip if confidence[slot] < CONFIDENCE_THRESHOLD → add to needsClarification
// 4. If slot already in priorResolvedSlots and value differs (correction):
//      skip if confidence[slot] < CORRECTION_THRESHOLD → add to needsClarification
// 5. Otherwise → commit: add to committedSlots

// Contract change detection:
// If activeContract.intentKind !== priorContract?.intentKind:
//   reset priorResolvedSlots — do not carry forward slots from prior contract
//   (safe default: force re-clarification rather than committing stale slots)
```

**`missingSlots`** = `activeContract.requiredSlots` filtered to those absent from
`committedSlots` after all commit decisions. This is the only place `missingSlots` is derived —
it never comes from the extractor or the classifier.

**`needsClarification`** feeds directly into `decideTurnPolicy` as targeted clarification slots.
The user gets "Did you mean 5pm?" not a generic re-ask.

**Acceptance criteria:**
- Informational turn containing "3pm" does not commit `time` — `committedSlots` equals
  `priorResolvedSlots` unchanged
- Low confidence extraction (`confidence.time = 0.6`) adds `time` to `needsClarification`,
  does not commit
- Correction of existing slot at 0.8 confidence does not commit (below `CORRECTION_THRESHOLD`)
- Correction at 0.92 confidence commits and overwrites
- Contract change from `intentKind: "plan"` to `intentKind: "edit"` resets prior slots
- `missingSlots` reflects post-commit state, not pre-commit extraction
- All logic is pure and synchronous — no async, no LLM calls

---

### Phase 3 — Replace analyzeWriteSignals with the LLM classifier

**Goal:** The LLM handles `turnType` classification. The heuristic path is demoted to a
pre-filter for a narrow set of high-confidence cases only. `analyzeWriteSignals` is removed.

**New file: `src/llmClassifier.ts`**

```typescript
export type ClassifierInput = {
  normalizedText: string;
  discourseState: DiscourseState;
  entityRegistry: ConversationEntity[];
};

export type ClassifierOutput = {
  turnType: TurnInterpretation["turnType"];
  confidence: number;
  resolvedEntityIds: string[];
  resolvedProposalId?: string;
};

export async function classifyTurn(input: ClassifierInput): Promise<ClassifierOutput>
```

**LLM call contract:**
- Model: fast/cheap tier — output is small and structured
- Output: JSON matching `ClassifierOutput` exactly, no prose
- System prompt constrains `turnType` to the enum values only
- Pass full `discourseState` and `entityRegistry` — the LLM needs these to resolve pronouns,
  identify active proposals, and understand clarification state
- `reasoning` field may be included in raw LLM response for debugging but stripped before return

**Heuristic pre-filter (fast exit, runs before LLM call):**

Only classify deterministically if ALL conditions are met:

```typescript
// Fast-exit confirmation: exact match + exactly one active/presented proposal
if (isConfirmationTurn(lower) && activeProposals.length === 1) {
  return { turnType: "confirmation", confidence: 0.97, ... }
}

// Fast-exit informational: question lead + no write verbs + no active clarifications
if (isInformationalTurn(lower) && activeClarifications.length === 0 && !containsWriteVerb(lower)) {
  return { turnType: "informational", confidence: 0.93, ... }
}

// Everything else → LLM
```

The pre-filter must NOT classify `clarification_answer`, `edit_request`, `planning_request`, or
`follow_up_reply` — those always go to the LLM.

**Update `interpretTurn.ts`:**
- Remove `analyzeWriteSignals`, `isEditRequest`, `deriveWriteAmbiguity`, `deriveWriteConfidence`,
  `deriveMissingSlots`, `deriveClarificationAnswerMissingSlots`
- `interpretTurn` becomes `async` — awaits `classifyTurn`
- Return shape of `TurnInterpretation` drops `missingSlots` and `ambiguity` — both move to
  the policy layer in Phase 4
- `STOPWORDS` set removed

**Acceptance criteria:**
- LLM correctly classifies `"5pm"` as `clarification_answer` when active clarifications present
- LLM correctly classifies `"ok"` as `confirmation` when a presented proposal exists
- LLM correctly classifies `"after the standup"` as `clarification_answer` in context
- Pre-filter never fires for clarification answers or edit requests
- `interpretTurn` return type no longer includes `missingSlots` or `ambiguity`

---

### Phase 4 — Refactor decideTurnPolicy to compose all layers

**Goal:** `decideTurnPolicy` receives classifier output and commit policy output. It derives
ambiguity, routes to an action, and returns `committedSlots` for the caller to persist. No new
extraction or classification logic lives here — this phase is composition only, plus the Bug 2
and Bug 4 fixes that couldn't land earlier.

**Update call site (wherever `interpretTurn` and `decideTurnPolicy` are called):**

```typescript
// 1. Classify intent
const classification = await classifyTurn({ normalizedText, discourseState, entityRegistry });

// 2. Extract slots (conditional)
const SLOT_COMMITTING_TURN_TYPES = new Set(["clarification_answer","planning_request","edit_request"]);
const slotExtraction = SLOT_COMMITTING_TURN_TYPES.has(classification.turnType)
  ? await extractSlots({
      currentTurnText: normalizedText,
      pendingSlots: derivePendingSlots(discourseState),
      priorResolvedSlots: discourseState.resolved_slots,
      conversationContext: getRecentTurns(discourseState),
    })
  : null;

// 3. Apply commit policy
const commitResult = applyCommitPolicy({
  turnType: classification.turnType,
  extractedValues: slotExtraction?.extractedValues ?? {},
  confidence: slotExtraction?.confidence ?? {},
  unresolvable: slotExtraction?.unresolvable ?? [],
  priorResolvedSlots: discourseState.resolved_slots,
  activeContract: discourseState.pending_write_contract,
  priorContract: previousContract,
});

// 4. Route
const policy = decideTurnPolicy({ classification, commitResult, routingContext });

// 5. Persist
await persistDiscourseState({ ...discourseState, resolved_slots: policy.committedSlots });
```

**Update `decideTurnPolicy.ts`:**

New input shape:

```typescript
export type DecideTurnPolicyInput = {
  classification: ClassifierOutput;
  commitResult: CommitPolicyOutput;
  routingContext: TurnRoutingInput;
};
```

Ambiguity decision table — derived from both pipelines, not embedded in either:

```
classifier.confidence < 0.6                              → ambiguity: "high"
commitResult.missingSlots.length > 0                     → ambiguity: "high"
commitResult.needsClarification.length > 0               → ambiguity: "high"
classifier.confidence < 0.8                              → ambiguity: "low"
otherwise                                                → ambiguity: "none"
```

Fix `clarification_answer` routing (Bug 4) — remove unconditional `ready_needs_consent`:

```typescript
if (turnType === "clarification_answer") {
  if (commitResult.missingSlots.length > 0) {
    return not_ready([...commitResult.missingSlots, ...commitResult.needsClarification]);
  }

  const alreadyConfirmed = entityRegistry.some(
    e => e.kind === "proposal_option" &&
         e.id === classification.resolvedProposalId &&
         e.status === "confirmed"
  );

  if (alreadyConfirmed) return ready_for_execution;
  return ready_needs_consent;
}
```

Fix proposal status check (Bug 2) — update `deriveConsentRequirement` to match
`"active" | "presented"` not just `"active"`.

Return `commitResult.committedSlots` on `TurnPolicyDecision` — the caller persists this, the
function does not.

**Acceptance criteria:**
- Full flow: `"schedule a meeting tomorrow"` → ask time → `"5pm"` → present_proposal →
  `"ok"` → recover_and_execute. No loops.
- Full flow: `"after the standup"` resolves `time` and exits clarification state
- Full flow: `"whenever"` (unresolvable) routes back to targeted clarification, not generic loop
- Informational turn with time string does not alter `committedSlots`
- Low-confidence extraction routes to targeted `needsClarification` re-ask
- `clarification_answer` post-confirmation routes to `execute_mutation` not `present_proposal`
- Contract change mid-flow resets slots and re-clarifies
- All existing `decideTurnPolicy` unit tests pass or are updated to new input shape

---

## Cross-Phase Invariants

These must hold after every phase, not just at the end:

- `TurnPolicyDecision` output shape does not change for callers except gaining `committedSlots`
- `DiscourseState` is never mutated inside the pipeline — caller persists `committedSlots`
- Both LLM calls (classifier + extractor) are the only async boundaries — `applyCommitPolicy`
  and `decideTurnPolicy` remain synchronous
- Slot extraction never throws — malformed LLM responses surface as `unresolvable`, not errors
- The normalizer is the state boundary — `resolvedSlots` never holds a raw LLM string
- `missingSlots` is derived only in `applyCommitPolicy` — never in the extractor or classifier

---

## What Is NOT Changing

- `TurnPolicyDecision` output contract (action, reason, requiresWrite, requiresConfirmation,
  useMutationPipeline, targetEntityId, targetProposalId, mutationInputSource, clarificationSlots)
  — `committedSlots` is additive
- The proposal/consent flow shape (`present_proposal` → user confirms → `recover_and_execute`)
- `entityRegistry` pattern and `ConversationEntity` kind/status structure (except adding statuses)
- `getActivePendingClarifications` from `@atlas/core`
- `looksLikeFollowUpReply` heuristic (low-risk, keep as-is)

---

## What Replaces What

| Old | New | Phase |
|-----|-----|-------|
| `analyzeWriteSignals` | LLM classifier (Pipeline A) | 3 |
| `deriveClarificationAnswerMissingSlots` | `applyCommitPolicy` | 2B |
| `deriveMissingSlots` | `applyCommitPolicy` | 2B |
| `deriveWriteAmbiguity` | ambiguity table in `decideTurnPolicy` | 4 |
| `deriveWriteConfidence` | classifier confidence passthrough | 3 |
| `slotResolver.ts` (regex) | `slotExtractor.ts` (LLM + normalizer) | 2A |
| `hasClockTime` boolean | `extractedValues.time` + confidence | 2A |

---

## Suggested Phase Order for Claude Code

Work strictly in phase order. Each phase has a clean accept/reject gate before the next begins.

Phase 2 is the most significant change from the original handoff. It splits into two parts —
build and test them in order: extractor first (2A), commit policy second (2B). The commit policy
unit tests do not require a live LLM — mock `SlotExtractorOutput` directly.

Do not start Phase 3 before Phase 2B's commit policy has passing unit tests covering the
correction threshold and contract change cases. These are the robustness guarantees everything
downstream depends on.

Phase 4 should feel like wiring. If logic beyond the ambiguity table and the Bug 2/4 fixes is
growing in `decideTurnPolicy`, it belongs in `applyCommitPolicy` — push it back up.

## Observability and provenance

### Turn traces
Every turn produces a `TurnTrace` record emitted to the observability sink after
`decideTurnPolicy` returns. Traces are never awaited — fire and forget, never block the
routing path. Include `rawLLMExtraction` (pre-normalizer) as a distinct field — this is
the only way to distinguish normalizer bugs from extractor bugs in production.

### Slot provenance
`ResolvedSlots` carries a `_provenance` map recording which turn committed each slot,
the raw LLM value before normalization, confidence at commit time, and whether it was
a correction. Strip `_provenance` before passing `resolvedSlots` to the write contract
check or the mutation pipeline.

### What to alert on
- Classifier confidence < 0.6 on more than 5% of turns — thresholds need recalibration
- `unresolvable` rate > 20% for any slot — extractor prompt needs adjustment
- Correction threshold rejections — legitimate user corrections being blocked
- Contract change resets — may indicate upstream intent classification instability

### What not to log
Raw `normalizedText` and `conversationContext` may contain PII — sanitize or omit
before sending to the observability sink. `entityRegistry` entity names similarly.