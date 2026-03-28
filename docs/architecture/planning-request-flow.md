# Planning Request Flow

This document traces the complete lifecycle of a planning request — from a raw
Telegram message arriving at the webhook to a task being created and scheduled
on Google Calendar. It also serves as a code map for agents navigating the
conversation handling subsystem.

---

## Table of Contents

1. [High-level overview](#high-level-overview)
2. [Phase 1 — Ingestion (webhook + dedup)](#phase-1--ingestion-webhook--dedup)
3. [Phase 2 — Turn routing pipeline](#phase-2--turn-routing-pipeline)
   - [Step A — Intent classification](#step-a--intent-classification)
   - [Step B — Slot extraction](#step-b--slot-extraction)
   - [Step C — Commit policy](#step-c--commit-policy)
   - [Step D — Turn policy decision](#step-d--turn-policy-decision)
4. [Phase 3 — Execution branches](#phase-3--execution-branches)
   - [Branch: conversation-only (reply\_only / ask\_clarification / present\_proposal)](#branch-conversation-only)
   - [Branch: recover\_and\_execute](#branch-recover_and_execute)
   - [Branch: execute\_mutation](#branch-execute_mutation)
5. [Phase 4 — Planning and scheduling (processInboxItem)](#phase-4--planning-and-scheduling-processinboxitem)
6. [Phase 5 — Conversation state persistence](#phase-5--conversation-state-persistence)
7. [State machine: discourse modes](#state-machine-discourse-modes)
8. [Key seams and data contracts](#key-seams-and-data-contracts)
9. [Code map](#code-map)

---

## High-level overview

```
Telegram message
      │
      ▼
[webhook/route.ts]
      │  auth + parse
      ▼
[telegram-webhook.ts] ─── handleTelegramWebhook()
      │  dedup + ingress record
      │  load conversation state
      │
      ▼
[turn-router.ts] ─── routeMessageTurn()
      │  classify → extract slots → commit → decide policy
      │
      ├─── policy = reply_only / ask_clarification / present_proposal
      │         │
      │         ▼
      │    [conversation-response.ts] → LLM conversation reply
      │
      ├─── policy = recover_and_execute
      │         │
      │         ▼
      │    synthesizeMutationText() → planningInboxTextOverride
      │         │
      │         ▼
      │    [process-inbox-item.ts] → plan + schedule
      │
      └─── policy = execute_mutation
                │
                ▼
           [process-inbox-item.ts] → plan + schedule
                │
                ▼
           Google Calendar API (create / update event)
```

---

## Phase 1 — Ingestion (webhook + dedup)

**Entry point:** `apps/web/src/app/api/telegram/webhook/route.ts`
**Orchestrator:** `apps/web/src/lib/server/telegram-webhook.ts` → `handleTelegramWebhook()`

Steps in order:

1. **Auth check** — validates `x-telegram-bot-api-secret-token` header against
   `TELEGRAM_WEBHOOK_SECRET`. Returns 401 on mismatch.

2. **Parse + validate** — `telegramUpdateSchema.safeParse(payload)`. Ignores
   updates with no text/caption.

3. **User allowlist** — `isTelegramUserAllowed()`. Returns 403 for unknown users.

4. **Google Calendar gate** — `hasActiveGoogleCalendarConnection()`. If the user
   has no active connection, returns a one-time OAuth link and exits early. No
   planning happens until Calendar is connected.

5. **Dedup** — `recordIncomingTelegramMessageIfNew()`. Uses
   `update_id`-based idempotency key. Duplicate webhooks return 200 immediately
   without re-processing.

6. **Ingress + conversation append** — The user turn is persisted to the ingress
   store and appended to the conversation transcript via `appendConversationTurn()`.

7. **Load conversation state** — `loadConversationState()` fetches the current
   `DiscourseState`, entity registry, summary text, and recent transcript. Falls
   back to `listRecentConversationTurns()` (legacy) if no state exists yet.

8. **Follow-up intercept** — `tryHandleFollowUpReply()` checks if the message is
   a reply to an outstanding follow-up bundle. If matched, it short-circuits the
   main pipeline and routes via the follow-up handler.

---

## Phase 2 — Turn routing pipeline

**Entry point:** `apps/web/src/lib/server/turn-router.ts` → `routeMessageTurn()`

The router is a pure sequential pipeline with no side effects. It takes
`TurnRoutingInput` and returns `RoutedTurn` (interpretation + policy).

### Step A — Intent classification

**File:** `apps/web/src/lib/server/llm-classifier.ts` → `classifyTurn()`

- **Fast path:** if the text is a pure confirmation phrase ("ok", "yes", "do
  it", etc.) and exactly one `proposal_option` entity is `active` or
  `presented` in the registry, the turn is classified as `confirmation`
  without an LLM call.
- **LLM path:** calls `classifyTurnWithResponses()` from
  `@atlas/integrations`. The prompt is in
  `packages/integrations/src/prompts/turn-classifier.ts`.
- **Error fallback:** LLM failures return `unknown` at confidence `0.3`.

**Output:** `TurnClassifierOutput`
```ts
{
  turnType: "planning_request" | "edit_request" | "clarification_answer"
           | "confirmation" | "informational" | "follow_up_reply" | "unknown";
  confidence: number;           // 0–1
  resolvedEntityIds: string[];  // entities referenced in this turn
  resolvedProposalId?: string;  // if confirming a specific proposal
}
```

**Guard — compound confirmation reclassification:**
If classification is `confirmation` but the text also contains modification
signals (time, day, duration, or words like "but"/"instead"/"actually"),
`containsModificationPayload()` detects this and the turn is reclassified to
`clarification_answer`. This prevents edits from being silently dropped when
a user says something like "yes but make it 3pm".

### Step B — Write interpretation

**File:** `apps/web/src/lib/server/interpret-write-turn.ts` → `interpretWriteTurn()`
**Downstream:** `packages/integrations/src/prompts/interpret-write-turn.ts`

Write interpretation runs only for write-capable turns:
`planning_request`, `edit_request`, `clarification_answer`.

Unlike the old slot-extractor seam, this stage does not precompute pending
fields before the LLM call. It interprets the whole turn in one pass and
returns a turn-scoped `WriteInterpretation` object.

**Output:** `WriteInterpretation`
```ts
{
  operationKind: "plan" | "edit" | "reschedule" | "complete" | "archive";
  actionDomain: string;
  targetRef: TargetRef;
  taskName: string | null;
  fields: ResolvedFields;
  sourceText: string;
  confidence: Record<string, number>;
  unresolvedFields: string[];
}
```

**Schedule field types** (grouped under `fields.scheduleFields`):
```ts
{
  day?: string;       // e.g. "monday", "tomorrow"
  time?: TimeSpec;    // absolute {hour,minute}, relative {minutes}, or window {morning|afternoon|evening}
  duration?: number;  // minutes
}
```

Target entity resolution still stays on the classifier side in Phase 2 via
`classification.resolvedEntityIds`; `targetRef` is available for richer later
phases and descriptive continuity. The slot normalizer still validates ranges
and converts raw schedule values into typed fields.

### Step C — Commit policy

**File:** `packages/core/src/write-commit.ts` → `applyWriteCommit()`

The commit step is the gate between "LLM interpreted something" and "the
system will act on it". Each interpreted field is individually evaluated:

| Condition | Result |
|-----------|--------|
| Field is in `unresolvedFields` | → `needsClarification` |
| `confidence[fieldPath] < 0.75` | → `needsClarification` |
| Field corrects a prior value AND `confidence < 0.90` | → `needsClarification` |
| Otherwise | → `resolvedFields.scheduleFields` |

The correction threshold (0.90 vs 0.75) is higher because overwriting a field
the user previously confirmed carries more risk.

**Required-field derivation:** required fields are derived inside commit from
`interpretation.operationKind`, not before interpretation.

**Workflow change detection:** if the interpreted `operationKind` changed from
the prior operation, or if the effective target changed, all prior resolved
workflow fields are discarded so stale data does not bleed into a new workflow.
`workflowChanged: true` is surfaced so `buildResolvedOperation` can reset
`originatingText` and `startedAt`.

**Target resolution:** `resolvedTargetRef` is the canonical next target —
`currentTargetEntityId` when the classifier resolved one, otherwise carried
forward from `priorPendingWriteOperation.targetRef`.

**Output:** `CommitPolicyOutput`
```ts
{
  resolvedFields: ResolvedFields;   // grouped fields safe to act on
  resolvedTargetRef: TargetRef;     // canonical target for this workflow step
  needsClarification: string[];     // dot-path fields not confident enough (e.g. "scheduleFields.time")
  missingFields: string[];          // required by operationKind, not yet resolved
  workflowChanged: boolean;         // true when operation or target switched
  committedFieldPaths: string[];
}
```

### Step D — Turn policy decision

**File:** `apps/web/src/lib/server/decide-turn-policy.ts` → `decideTurnPolicy()`
**Helpers:** `packages/core/src/proposal-rules.ts`, `packages/core/src/ambiguity.ts`

This is the state machine's decision function. It maps
`(turnType, commitResult, entityRegistry)` → `TurnPolicyAction`.

**Ambiguity derivation** (`packages/core/src/ambiguity.ts`):
- `"high"` — classifier confidence < 0.6, OR missing slots, OR needsClarification
- `"low"` — classifier confidence < 0.8
- `"none"` — fully ready

**Policy actions:**

| Turn type | Conditions | Action |
|-----------|-----------|--------|
| `informational` / `follow_up_reply` | — | `reply_only` |
| `confirmation` | active proposal found in registry | `recover_and_execute` |
| `confirmation` | no recoverable proposal | `present_proposal` |
| `planning_request` / `edit_request` / `clarification_answer` | ambiguity = high OR missing/clarification slots remain | `ask_clarification` |
| `planning_request` / `edit_request` / `clarification_answer` | consent required (first-time write or slot change) | `present_proposal` |
| `planning_request` / `edit_request` / `clarification_answer` | all slots committed, no consent needed | `execute_mutation` |
| `unknown` | no write verbs detected | `reply_only` |
| `unknown` | write verbs present | `ask_clarification` |

**Consent requirement** (`packages/core/src/proposal-rules.ts` →
`deriveConsentRequirement()`): consent is required when there is no prior
confirmed proposal for the target entity, or when committed slots have changed
relative to a prior proposal.

**Policy decision output** (`TurnPolicyDecision`):
```ts
{
  action: TurnPolicyAction;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  useMutationPipeline: boolean;
  targetEntityId?: string;
  targetProposalId?: string;
  mutationInputSource?: "direct_user_turn" | "recovered_proposal";
  clarificationSlots?: string[];    // dot-path fields (e.g. "scheduleFields.time")
  resolvedOperation?: PendingWriteOperation;  // set for non-reply_only turns
}
```

---

## Phase 3 — Execution branches

Back in `handleTelegramWebhook()`, the routed turn is inspected and dispatched
to one of three branches. Before branching, an **immediate feedback** message
is sent (typing indicator or placeholder text) so the user sees activity while
the actual processing happens.

### Branch: conversation-only

**Condition:** `!doesPolicyAllowWrites(policy.action)` — covers `reply_only`,
`ask_clarification`, `present_proposal`.

**File:** `apps/web/src/lib/server/conversation-response.ts` →
`buildConversationResponse()`
**Downstream:** `packages/integrations` → `respondToConversationTurnWithResponses()`

The LLM is given the turn route, recent turns, memory summary, entity
registry, discourse state, and clarification slots. It produces a
free-form reply. For `ask_clarification` and `present_proposal` this reply
contains the clarification question or proposal text.

After the reply is sent, `deriveConversationReplyState()` updates the discourse
state to track the pending clarification or proposal in the entity registry.

### Branch: recover\_and\_execute

**Condition:** `policy.action === "recover_and_execute"`

A prior proposal exists in the entity registry and the user confirmed it. The
system needs to synthesize the mutation request from the proposal and committed
slots rather than using the raw user text directly.

**File:** `packages/core/src/synthesize-mutation-text.ts` →
`synthesizeMutationText()`

This function builds a well-formed natural-language mutation request by:
1. Using the original user turn text that created the proposal, augmented with
   slot values.
2. Falling back to synthesizing from slot values alone if the proposal entity
   lacks a stored text.

The synthesized text is passed as `planningInboxTextOverride` to
`processInboxItem()`, replacing the raw user message so the planner sees a
clean, unambiguous instruction.

**Fallback:** if synthesis returns `insufficient_data` (no proposal entity and
no usable slots), the system asks a clarification instead of attempting a
broken plan.

### Branch: execute\_mutation

**Condition:** `policy.action === "execute_mutation"`

The user turn is fully ready for execution — all required slots are committed
and no consent prompt is needed. `processInboxItem()` is called directly with
the raw inbox item text (no override).

---

## Phase 4 — Planning and scheduling (processInboxItem)

**File:** `apps/web/src/lib/server/process-inbox-item.ts` →
`processInboxItem()`

This is the only layer that writes tasks and schedule blocks.

### 4.1 — Context loading

`store.loadContext(inboxItemId)` fetches:
- The inbox item (raw/normalized text, user ID, timestamps)
- User profile (timezone, preferences)
- Existing tasks (open and scheduled)
- Existing schedule blocks

### 4.2 — Planning context assembly

`buildInboxPlanningContext()` (`@atlas/core`) packs all context into the
structured input the LLM planner expects. If `planningInboxTextOverride` was
provided (from the recovery branch), it replaces the inbox item text.

### 4.3 — LLM planner call

`planInboxItemWithResponses()` (`@atlas/integrations`) calls the planner LLM.
Prompt: `packages/integrations/src/prompts/planner.ts`.

**Output:** `InboxPlanningOutput`
```ts
{
  confidence: number;
  actions: PlanningAction[];
}
```

**Planning actions:**
- `create_task` — create a new task with title, priority, urgency
- `create_schedule_block` — schedule a task (references `created_task` alias or `existing_task` alias)
- `move_schedule_block` — reschedule an existing block
- `complete_task` — mark a task done
- `clarify` — model is not confident, requests clarification

### 4.4 — Action dispatch (applyPlanningResult)

The planner output is validated and dispatched:

```
actions
  │
  ├── clarify only        → saveNeedsClarificationResult()
  ├── move only           → applyMoveAction()
  ├── create_task(s)      → applyCreatedTaskActions()
  ├── complete_task(s)    → applyCompletionActions()
  └── create_schedule     → applyExistingTaskScheduleActions()
       (existing tasks)
```

Mixed action sets (e.g. clarify + create) are rejected as invalid and fall
back to a clarification reply.

### 4.5 — Schedule proposal + calendar write

For any action that needs scheduling, the flow is:

1. **Busy period fetch** — `calendar.listBusyPeriods()` returns a 14-day
   window of occupied slots from Google Calendar. Atlas task blocks are
   filtered out to avoid double-counting.

2. **Schedule proposal** — `buildScheduleProposal()` (`@atlas/core`) picks a
   non-conflicting slot based on the planner's `scheduleConstraint` and user
   preferences.

3. **Calendar write** — `scheduleTaskWithCalendar()`:
   - If the task already has an `externalCalendarEventId`, calls
     `calendar.updateEvent()`.
   - Otherwise, calls `calendar.createEvent()`.
   - Returns a `ScheduleBlock` with the confirmed `startAt`/`endAt`.

4. **Persist** — `store.saveTaskCaptureResult()` or
   `store.saveScheduleRequestResult()` writes tasks and blocks to the DB.

### 4.6 — Move action (rescheduling)

`applyMoveAction()` adds extra safety steps:

1. `buildScheduleAdjustment()` computes the new slot.
2. `calendar.getEvent()` fetches the **live** event from Google Calendar to
   detect external edits.
3. `detectTaskCalendarDrift()` compares the live event against the DB record.
   If they differ, it marks the task `out_of_sync` and returns a clarification
   instead of silently overwriting.
4. Only if no drift → `calendar.updateEvent()` is called.

### 4.7 — Ambiguity detection

Before scheduling an existing task, `hasAmbiguousTaskTitle()` checks whether
multiple actionable tasks share the same (normalized) title. If so, a
disambiguation reply is returned listing all candidates with their current
schedule state.

---

## Phase 5 — Conversation state persistence

After any branch completes, the conversation state is updated:

**Non-mutation branch:**
`deriveConversationReplyState()` (`apps/web/src/lib/server/conversation-state.ts`)

- Appends assistant turn to transcript
- Updates `DiscourseState` with:
  - New pending clarification (for `ask_clarification`)
  - New proposal entity (for `present_proposal`)
  - Conversation mode update (planning → clarifying / confirming)
  - `pending_write_operation` updated from `policy.resolvedOperation` (non-`reply_only` turns only)

**Mutation branch:**
`deriveMutationState()` (`apps/web/src/lib/server/conversation-state.ts`)

- Appends assistant turn to transcript
- Clears pending clarifications and proposals
- Updates entity registry with created tasks/blocks as focus entities
- Resets discourse mode to `planning`

Both paths call `saveConversationState()` to persist the new snapshot.

---

## State machine: discourse modes

The `DiscourseState.mode` field tracks where the conversation stands. It
drives how the next turn is interpreted.

```
         user sends planning request
                    │
                    ▼
              [ planning ]
              (default mode)
                    │
         ┌──────────┼──────────┐
         │          │          │
  ask_clarification │   present_proposal
         │          │          │
         ▼          │          ▼
   [ clarifying ]   │   [ confirming ]
         │          │          │
  clarification     │    user confirms
    resolved        │          │
         │          │          │
         └──────────┴──────────┘
                    │
              execute_mutation
                    │
                    ▼
           [ planning ] (reset)
```

Mode derivation is in `packages/core/src/discourse-state.ts`. The mode is
computed, not stored directly — it is derived from whether there are pending
clarifications or presented proposals in the entity registry.

**`editing` mode** is entered when an `edit_request` turn arrives and an
editable entity is present. It is structurally similar to `planning` but the
`edit` operationKind requires only `time`.

---

## Key seams and data contracts

### Seam 1: Classify → Commit

**From:** `classifyTurn()` → `TurnClassifierOutput`
**To:** `applyCommitPolicy()` → `CommitPolicyOutput`

The classifier decides *what the user wants*. The commit policy decides *which
slot values are trustworthy enough to act on*. The two are deliberately
separate — a high-confidence `planning_request` can still have low-confidence
slots.

### Seam 2: Commit → Policy decision

**From:** `applyCommitPolicy()` → `CommitPolicyOutput`
**To:** `decideTurnPolicy()` → `TurnPolicyDecision`

The policy decision reads `missingFields` and `needsClarification` from the
commit output to determine whether the system can proceed or must ask. It also
reads the entity registry to check for consent requirements.

### Seam 3: Policy → Execution branch

**From:** `decideTurnPolicy()` → `TurnPolicyAction`
**To:** `handleTelegramWebhook()` dispatch switch

`doesPolicyAllowWrites(action)` is the gate. `true` for
`execute_mutation` and `recover_and_execute`; `false` for everything else.

### Seam 4: Recovery → Planning override

**From:** `synthesizeMutationText()` → `{ outcome, text }`
**To:** `processInboxItem({ planningInboxTextOverride: { text } })`

When recovering a confirmed proposal, the raw user text ("yes" / "ok") is
unusable for planning. The synthesized text replaces it with a specific
instruction the planner can act on.

### Seam 5: Planner → Action dispatch

**From:** `planInboxItemWithResponses()` → `InboxPlanningOutput`
**To:** `applyPlanningResult()` dispatch

The planner output is a list of typed actions. `applyPlanningResult` validates
the combination (mixed action sets are rejected) and routes to the correct
apply function.

### Seam 6: Schedule proposal → Calendar write

**From:** `buildScheduleProposal()` → `ScheduleProposal`
**To:** `scheduleTaskWithCalendar()` → `ScheduleBlock`

The proposal picks a time slot in-process. The calendar write is a separate
step that creates/updates the Google Calendar event and returns the confirmed
block with the external event ID.

---

## Code map

### `apps/web/src/app/api/telegram/webhook/route.ts`
Next.js route handler. Thin shell — just calls `handleTelegramWebhook()`.

### `apps/web/src/lib/server/telegram-webhook.ts`
Main orchestrator. Owns the full request lifecycle: auth, dedup, state load,
routing dispatch, execution branch selection, reply delivery, and state save.
All dependencies are injected for testability.

### `apps/web/src/lib/server/turn-router.ts`
Pure pipeline. Composes classify → interpret → commit → decide into a single
`RoutedTurn`. Contains `containsModificationPayload()` (compound confirmation
guard) and `doesPolicyAllowWrites()` / `getConversationRouteForPolicy()`
helpers used by the webhook orchestrator.

### `apps/web/src/lib/server/llm-classifier.ts`
Intent classification. Fast-path for pure confirmations with an active
proposal. Falls back to LLM via `@atlas/integrations`.

### `apps/web/src/lib/server/interpret-write-turn.ts`
Write interpretation boundary. Calls the unified write-interpretation prompt
and normalizes the raw response into `WriteInterpretation`.

### `apps/web/src/lib/server/decide-turn-policy.ts`
Turn policy decision. Pure function. Maps intent + commit result + entity
registry → policy action. Uses `deriveStructuredWriteReadiness()` for the
three write-capable turn types.

### `apps/web/src/lib/server/conversation-response.ts`
Conversation-only reply builder. Calls `respondToConversationTurnWithResponses()`
from `@atlas/integrations`.

### `apps/web/src/lib/server/conversation-state.ts`
State transition functions. `deriveConversationReplyState()` handles
non-mutation outcomes. `deriveMutationState()` handles mutation outcomes.
Both return the new state to be persisted — they do not write directly.

### `apps/web/src/lib/server/process-inbox-item.ts`
Planning and scheduling executor. Loads context, calls the planner LLM,
dispatches actions, writes to calendar and DB. The only file that calls
`calendar.createEvent()` or `calendar.updateEvent()`.

### `apps/web/src/lib/server/mutation-reply.ts`
User-facing reply renderer for mutation outcomes. Converts
`ProcessedInboxResult` to a human-readable message in the user's timezone.

### `packages/core/src/write-commit.ts`
Grouped field gating logic. Thresholds: 0.75 (normal), 0.90 (correction).
Required fields are derived from `operationKind` inside commit. Operation or
target changes clear prior workflow fields and set `workflowChanged`.
Outputs `resolvedTargetRef` as the canonical next target.
Pure function, no LLM calls.

### `packages/core/src/discourse-state.ts`
All discourse state schema types, helpers, and mode derivation. Contains
`resolveReference()` (reference resolution fallback chain), clarification
management, and `updateDiscourseStateFromUserTurn/AssistantTurn`.

### `packages/core/src/proposal-rules.ts`
Consent and proposal compatibility logic. `deriveConsentRequirement()`,
`deriveProposalCompatibility()`, `containsWriteVerb()`.

### `packages/core/src/ambiguity.ts`
`deriveAmbiguity()` — maps classifier confidence + slot gaps to
`"none" | "low" | "high"`.

### `packages/core/src/slot-normalizer.ts`
Raw LLM slot output → typed `ResolvedSlots`. Validates ranges, converts time
windows and relative times.

### `packages/core/src/synthesize-mutation-text.ts`
Builds mutation request text for the proposal recovery path. Uses proposal
entity + entity registry + committed slots.

### `packages/integrations/src/prompts/turn-classifier.ts`
LLM prompt for intent classification.

### `packages/integrations/src/prompts/interpret-write-turn.ts`
LLM prompt for unified write interpretation.

### `packages/integrations/src/prompts/planner.ts`
LLM prompt for inbox item planning. Receives full planning context; outputs
typed action list.

### `packages/integrations/src/prompts/conversation-response.ts`
LLM prompt for conversation-only replies (clarification questions, proposals,
informational responses).

### `packages/integrations/src/prompts/confirmed-mutation-recovery.ts`
LLM prompt used when synthesizing a mutation from a recovered proposal is
insufficient and a recovery conversation turn is needed.
