# Deterministic Mutation Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the planner LLM and `processInboxItem` orchestrator with a deterministic executor that operates directly on `pendingWriteOperation`, eliminating redundant LLM calls, wrong-entity references, and wasted tokens.

**Architecture:** A new `executePendingWrite` orchestrator in `apps/web/src/lib/server/` switches on `operationKind` and deterministically produces a `MutationResult` (defined in `packages/core`). Calendar helpers and ambiguous-title helpers are extracted from `process-inbox-item.ts` into a dedicated `calendar-scheduling.ts` module. The policy layer drops `recover_and_execute` — confirmations now rehydrate `pendingWriteOperation` from the proposal entity and produce `execute_mutation`. The two mutation branches in the webhook collapse to one.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm workspaces (`@atlas/core`, `@atlas/db`, `@atlas/integrations`, `@atlas/web`)

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `packages/core/src/mutation-result.ts` | `MutationResult` type definition |
| `apps/web/src/lib/server/calendar-scheduling.ts` | Extracted calendar helpers (scheduling, busy periods, drift detection, logging) |
| `apps/web/src/lib/server/ambiguous-title.ts` | Extracted ambiguous-title detection helpers |
| `apps/web/src/lib/server/execute-pending-write.ts` | Deterministic mutation executor |
| `apps/web/src/lib/server/execute-pending-write.test.ts` | Executor unit tests |
| `apps/web/src/lib/server/rehydrate-proposal.ts` | Proposal → PendingWriteOperation rehydration |
| `apps/web/src/lib/server/rehydrate-proposal.test.ts` | Rehydration tests |

### Modified files
| File | Change |
|------|--------|
| `packages/core/src/discourse-state.ts` | Add `urgency` to `taskFields` in `resolvedFieldsSchema` |
| `packages/core/src/index.ts` | Export `MutationResult`, add `operationKind` to proposal entity `data` schema, remove `recover_and_execute` from `TurnPolicyAction`, remove `mutationInputSource` from `TurnPolicyDecision` |
| `packages/db/src/planner.ts` | Remove `plannerRun` from store method input types, update return types from `ProcessedInboxResult` to `MutationResult` |
| `apps/web/src/lib/server/decide-turn-policy.ts` | Confirmations produce `execute_mutation` with rehydrated operation instead of `recover_and_execute` |
| `apps/web/src/lib/server/conversation-state.ts` | `deriveMutationState` consumes `MutationResult` instead of `ProcessedInboxResult` |
| `apps/web/src/lib/server/mutation-reply.ts` | Accept `MutationResult` instead of `ProcessedInboxResult` |
| `apps/web/src/lib/server/telegram-webhook.ts` | Collapse two mutation branches into one `executePendingWrite` call |
| `apps/web/src/lib/server/decide-turn-policy.test.ts` | Update tests: no `recover_and_execute`, confirmations → `execute_mutation` |
| `apps/web/src/lib/server/conversation-state.test.ts` | `MutationResult` instead of `ProcessedInboxResult`, no `plannerRun` |
| `apps/web/src/lib/server/telegram-webhook.test.ts` | Mock `executePendingWrite` instead of `processInboxItem` |

### Deleted files
| File | Reason |
|------|--------|
| `apps/web/src/lib/server/process-inbox-item.ts` | Replaced by `executePendingWrite` |
| `apps/web/src/lib/server/process-inbox-item.test.ts` | Tests for deleted module |
| `packages/integrations/src/prompts/planner.ts` | Planner LLM prompt no longer needed |
| `packages/integrations/src/manual/planner.eval-suite.ts` | Planner eval suite no longer needed |
| `packages/core/src/synthesize-mutation-text.ts` | No longer needed — executor uses structured fields directly |
| Tests for `synthesize-mutation-text.ts` | Tests for deleted module |

---

### Task 1: Define `MutationResult` type in `packages/core`

**Files:**
- Create: `packages/core/src/mutation-result.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create a test that imports `MutationResult` from `@atlas/core` and asserts the type exists with the expected discriminants:

```ts
// packages/core/src/mutation-result.test.ts
import { describe, expect, it } from "vitest";
import type { MutationResult } from "./mutation-result";

describe("MutationResult type", () => {
  it("accepts a created outcome", () => {
    const result: MutationResult = {
      outcome: "created",
      tasks: [],
      scheduleBlocks: [],
      followUpMessage: "Saved.",
    };
    expect(result.outcome).toBe("created");
  });

  it("accepts a scheduled outcome", () => {
    const result: MutationResult = {
      outcome: "scheduled",
      tasks: [],
      scheduleBlocks: [],
      followUpMessage: "Scheduled.",
    };
    expect(result.outcome).toBe("scheduled");
  });

  it("accepts a rescheduled outcome", () => {
    const result: MutationResult = {
      outcome: "rescheduled",
      updatedBlock: {
        id: "block-1",
        userId: "user-1",
        taskId: "task-1",
        startAt: "2026-04-06T09:00:00Z",
        endAt: "2026-04-06T10:00:00Z",
        confidence: 0.9,
        reason: "moved",
        rescheduleCount: 1,
        externalCalendarId: null,
      },
      followUpMessage: "Rescheduled.",
    };
    expect(result.outcome).toBe("rescheduled");
  });

  it("accepts a completed outcome", () => {
    const result: MutationResult = {
      outcome: "completed",
      tasks: [],
      followUpMessage: "Done.",
    };
    expect(result.outcome).toBe("completed");
  });

  it("accepts an archived outcome", () => {
    const result: MutationResult = {
      outcome: "archived",
      tasks: [],
      followUpMessage: "Archived.",
    };
    expect(result.outcome).toBe("archived");
  });

  it("accepts a needs_clarification outcome", () => {
    const result: MutationResult = {
      outcome: "needs_clarification",
      reason: "ambiguous target",
      followUpMessage: "Which task?",
    };
    expect(result.outcome).toBe("needs_clarification");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @atlas/core test -- --run mutation-result`
Expected: FAIL — cannot resolve `./mutation-result`

- [ ] **Step 3: Write the type definition**

```ts
// packages/core/src/mutation-result.ts
import type { ScheduleBlock, Task } from "./index";

export type MutationResult =
  | {
      outcome: "created";
      tasks: Task[];
      scheduleBlocks: ScheduleBlock[];
      followUpMessage: string;
    }
  | {
      outcome: "scheduled";
      tasks: Task[];
      scheduleBlocks: ScheduleBlock[];
      followUpMessage: string;
    }
  | {
      outcome: "rescheduled";
      updatedBlock: ScheduleBlock;
      followUpMessage: string;
    }
  | {
      outcome: "completed";
      tasks: Task[];
      followUpMessage: string;
    }
  | {
      outcome: "archived";
      tasks: Task[];
      followUpMessage: string;
    }
  | {
      outcome: "needs_clarification";
      reason: string;
      followUpMessage: string;
    };
```

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

Add to `packages/core/src/index.ts`:

```ts
export { type MutationResult } from "./mutation-result";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @atlas/core test -- --run mutation-result`
Expected: PASS — all 6 assertions pass

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mutation-result.ts packages/core/src/mutation-result.test.ts packages/core/src/index.ts
git commit -m "feat: add MutationResult type to @atlas/core"
```

---

### Task 2: Schema changes — `urgency` in `resolvedFields` + `operationKind` on proposal entity

**Files:**
- Modify: `packages/core/src/discourse-state.ts` (add `urgency` to `taskFields`)
- Modify: `packages/core/src/index.ts` (add `operationKind` to proposal entity `data`)

- [ ] **Step 1: Write the failing test for urgency field**

```ts
// packages/core/src/discourse-state.test.ts (append to existing file)
import { resolvedFieldsSchema } from "./discourse-state";

describe("resolvedFieldsSchema urgency", () => {
  it("accepts urgency in taskFields", () => {
    const result = resolvedFieldsSchema.parse({
      taskFields: { urgency: "high" },
    });
    expect(result.taskFields?.urgency).toBe("high");
  });

  it("rejects invalid urgency value", () => {
    expect(() =>
      resolvedFieldsSchema.parse({
        taskFields: { urgency: "critical" },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @atlas/core test -- --run discourse-state`
Expected: FAIL — `urgency` not in schema, parsed result has no `urgency`

- [ ] **Step 3: Add urgency to resolvedFieldsSchema**

In `packages/core/src/discourse-state.ts`, modify the `taskFields` object in `resolvedFieldsSchema`:

```ts
taskFields: z
  .object({
    priority: z.string().optional(),
    urgency: z.enum(["low", "medium", "high"]).optional(),
    label: z.string().optional(),
    sourceText: z.string().optional(),
  })
  .optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @atlas/core test -- --run discourse-state`
Expected: PASS

- [ ] **Step 5: Write the failing test for operationKind on proposal entity**

```ts
// packages/core/src/index.test.ts (append or create)
import { conversationProposalOptionEntitySchema, operationKindSchema } from "./index";

describe("proposal entity operationKind", () => {
  it("accepts operationKind in proposal data", () => {
    const entity = {
      id: "ent-1",
      conversationId: "conv-1",
      kind: "proposal_option",
      label: "Schedule gym",
      status: "active",
      createdAt: "2026-04-05T10:00:00Z",
      updatedAt: "2026-04-05T10:00:00Z",
      data: {
        route: "conversation_then_mutation",
        replyText: "Schedule gym at 5pm?",
        fieldSnapshot: {},
        operationKind: "plan",
      },
    };
    const parsed = conversationProposalOptionEntitySchema.parse(entity);
    expect(parsed.data.operationKind).toBe("plan");
  });

  it("allows proposal entity without operationKind for backwards compat", () => {
    const entity = {
      id: "ent-1",
      conversationId: "conv-1",
      kind: "proposal_option",
      label: "Schedule gym",
      status: "active",
      createdAt: "2026-04-05T10:00:00Z",
      updatedAt: "2026-04-05T10:00:00Z",
      data: {
        route: "conversation_then_mutation",
        replyText: "Schedule gym at 5pm?",
        fieldSnapshot: {},
      },
    };
    const parsed = conversationProposalOptionEntitySchema.parse(entity);
    expect(parsed.data.operationKind).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @atlas/core test -- --run index`
Expected: FAIL — `operationKind` not in schema

- [ ] **Step 7: Add operationKind to proposal entity data schema**

In `packages/core/src/index.ts`, find `conversationProposalOptionEntitySchema` and add to its `data` object:

```ts
operationKind: operationKindSchema.optional(),
```

Import `operationKindSchema` from `./discourse-state` if not already imported.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @atlas/core test -- --run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/discourse-state.ts packages/core/src/index.ts packages/core/src/discourse-state.test.ts packages/core/src/index.test.ts
git commit -m "feat: add urgency to resolvedFields, operationKind to proposal entity"
```

---

### Task 3: Extract calendar helpers to `calendar-scheduling.ts`

**Files:**
- Create: `apps/web/src/lib/server/calendar-scheduling.ts`
- Modify: `apps/web/src/lib/server/process-inbox-item.ts` (import from new module instead of inline)

This is a pure extraction — move functions, update imports, verify existing tests still pass.

- [ ] **Step 1: Create `calendar-scheduling.ts` with extracted functions**

Extract these functions from `process-inbox-item.ts` (lines 736–949) into `apps/web/src/lib/server/calendar-scheduling.ts`:

```ts
// apps/web/src/lib/server/calendar-scheduling.ts
import {
  buildBusyScheduleBlocks,
  type ScheduleBlock,
  type Task,
} from "@atlas/core";
import type {
  CalendarBusyPeriod,
  CalendarEventSnapshot,
  ExternalCalendarAdapter,
} from "@atlas/integrations";

const CALENDAR_BUSY_LOOKAHEAD_DAYS = 14;

export async function scheduleTaskWithCalendar(input: {
  calendar: ExternalCalendarAdapter;
  task: Task;
  selectedCalendarId: string | null;
  proposedBlock: ScheduleBlock;
}): Promise<ScheduleBlock> {
  const currentEvent = await getCurrentCalendarEvent(
    input.calendar,
    input.task,
  );
  const operation = currentEvent ? "update" : "create";
  const externalCalendarId =
    currentEvent?.externalCalendarId ??
    input.task.externalCalendarId ??
    input.proposedBlock.externalCalendarId ??
    input.selectedCalendarId;

  logCalendarWriteAttempt({
    operation,
    taskId: input.task.id,
    userId: input.task.userId,
    externalCalendarEventId: currentEvent?.externalCalendarEventId ?? null,
    externalCalendarId,
    startAt: input.proposedBlock.startAt,
    endAt: input.proposedBlock.endAt,
  });

  try {
    const calendarEvent = currentEvent
      ? await input.calendar.updateEvent({
          externalCalendarEventId: currentEvent.externalCalendarEventId,
          externalCalendarId: currentEvent.externalCalendarId,
          title: input.task.title,
          startAt: input.proposedBlock.startAt,
          endAt: input.proposedBlock.endAt,
        })
      : await input.calendar.createEvent({
          title: input.task.title,
          startAt: input.proposedBlock.startAt,
          endAt: input.proposedBlock.endAt,
          externalCalendarId,
        });

    logCalendarWriteSuccess({
      operation,
      taskId: input.task.id,
      userId: input.task.userId,
      externalCalendarEventId: calendarEvent.externalCalendarEventId,
      externalCalendarId: calendarEvent.externalCalendarId,
      startAt: calendarEvent.scheduledStartAt,
      endAt: calendarEvent.scheduledEndAt,
    });

    return buildScheduleBlockFromCalendarEvent({
      taskId: input.proposedBlock.taskId,
      userId: input.task.userId,
      reason: input.proposedBlock.reason,
      rescheduleCount: input.proposedBlock.rescheduleCount,
      confidence: input.proposedBlock.confidence,
      calendarEvent,
    });
  } catch (error) {
    logCalendarWriteFailure({
      operation,
      taskId: input.task.id,
      userId: input.task.userId,
      externalCalendarEventId: currentEvent?.externalCalendarEventId ?? null,
      externalCalendarId,
      startAt: input.proposedBlock.startAt,
      endAt: input.proposedBlock.endAt,
      error,
    });
    throw error;
  }
}

export async function buildRuntimeScheduleBlocks(input: {
  scheduleBlocks: ScheduleBlock[];
  tasks: Task[];
  userId: string;
  googleCalendarConnection: { selectedCalendarId: string } | null;
  calendar: ExternalCalendarAdapter;
  referenceTime: string;
}): Promise<ScheduleBlock[]> {
  const existingBlocks = [...input.scheduleBlocks];

  if (!input.googleCalendarConnection) {
    return existingBlocks;
  }

  const busyWindowStart = new Date(input.referenceTime);
  const busyWindowEnd = new Date(
    busyWindowStart.getTime() +
      CALENDAR_BUSY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
  );

  const busyPeriods = await input.calendar.listBusyPeriods({
    startAt: busyWindowStart.toISOString(),
    endAt: busyWindowEnd.toISOString(),
    externalCalendarId: input.googleCalendarConnection.selectedCalendarId,
  });

  return [
    ...existingBlocks,
    ...buildBusyScheduleBlocks({
      userId: input.userId,
      periods: filterBusyPeriodsAgainstAtlasTasks(input.tasks, busyPeriods),
    }),
  ];
}

export function filterBusyPeriodsAgainstAtlasTasks(
  tasks: Task[],
  busyPeriods: CalendarBusyPeriod[],
): CalendarBusyPeriod[] {
  return busyPeriods.filter(
    (period) =>
      !tasks.some(
        (task) =>
          task.externalCalendarId === period.externalCalendarId &&
          task.scheduledStartAt === period.startAt &&
          task.scheduledEndAt === period.endAt,
      ),
  );
}

export async function getCurrentCalendarEvent(
  calendar: ExternalCalendarAdapter,
  task: Task,
): Promise<CalendarEventSnapshot | null> {
  if (
    task.externalCalendarEventId === null ||
    task.externalCalendarId === null
  ) {
    return null;
  }

  return calendar.getEvent({
    externalCalendarEventId: task.externalCalendarEventId,
    externalCalendarId: task.externalCalendarId,
  });
}

export function buildScheduleBlockFromCalendarEvent(input: {
  taskId: string;
  userId: string;
  reason: string;
  rescheduleCount: number;
  confidence: number;
  calendarEvent: CalendarEventSnapshot;
}): ScheduleBlock {
  return {
    id: input.calendarEvent.externalCalendarEventId,
    userId: input.userId,
    taskId: input.taskId,
    startAt: input.calendarEvent.scheduledStartAt,
    endAt: input.calendarEvent.scheduledEndAt,
    confidence: input.confidence,
    reason: input.reason,
    rescheduleCount: input.rescheduleCount,
    externalCalendarId: input.calendarEvent.externalCalendarId,
  };
}

export function logCalendarWriteAttempt(input: {
  operation: "create" | "update";
  taskId: string;
  userId: string;
  externalCalendarEventId: string | null;
  externalCalendarId: string | null;
  startAt: string;
  endAt: string;
}) {
  console.info("calendar_write_attempt", input);
}

export function logCalendarWriteSuccess(input: {
  operation: "create" | "update";
  taskId: string;
  userId: string;
  externalCalendarEventId: string;
  externalCalendarId: string;
  startAt: string;
  endAt: string;
}) {
  console.info("calendar_write_succeeded", input);
}

export function logCalendarWriteFailure(input: {
  operation: "create" | "update";
  taskId: string;
  userId: string;
  externalCalendarEventId: string | null;
  externalCalendarId: string | null;
  startAt: string;
  endAt: string;
  error: unknown;
}) {
  console.error("calendar_write_failed", {
    operation: input.operation,
    taskId: input.taskId,
    userId: input.userId,
    externalCalendarEventId: input.externalCalendarEventId,
    externalCalendarId: input.externalCalendarId,
    startAt: input.startAt,
    endAt: input.endAt,
    error:
      input.error instanceof Error
        ? { name: input.error.name, message: input.error.message }
        : { message: String(input.error) },
  });
}
```

- [ ] **Step 2: Update `process-inbox-item.ts` to import from new module**

Replace the inline function definitions with imports:

```ts
import {
  buildRuntimeScheduleBlocks,
  buildScheduleBlockFromCalendarEvent,
  filterBusyPeriodsAgainstAtlasTasks,
  getCurrentCalendarEvent,
  logCalendarWriteAttempt,
  logCalendarWriteFailure,
  logCalendarWriteSuccess,
  scheduleTaskWithCalendar,
} from "./calendar-scheduling";
```

Remove the duplicated function bodies and the `CALENDAR_BUSY_LOOKAHEAD_DAYS` constant from `process-inbox-item.ts`. Adapt the `buildRuntimeScheduleBlocks` call sites — the new signature takes a flat input object instead of `ApplyPlanningResultInput["context"]`. Map existing arguments to the new shape at each call site.

- [ ] **Step 3: Run existing process-inbox-item tests**

Run: `pnpm --filter @atlas/web test -- --run process-inbox-item`
Expected: PASS — all existing tests pass unchanged (pure extraction, no behavior change)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/server/calendar-scheduling.ts apps/web/src/lib/server/process-inbox-item.ts
git commit -m "refactor: extract calendar helpers to calendar-scheduling.ts"
```

---

### Task 4: Extract ambiguous-title helpers to `ambiguous-title.ts`

**Files:**
- Create: `apps/web/src/lib/server/ambiguous-title.ts`
- Modify: `apps/web/src/lib/server/process-inbox-item.ts`

- [ ] **Step 1: Create `ambiguous-title.ts` with extracted functions**

Extract from `process-inbox-item.ts` (lines 998–1122):

```ts
// apps/web/src/lib/server/ambiguous-title.ts
import type { ScheduleBlock, Task } from "@atlas/core";

export function hasAmbiguousTaskTitle(tasks: Task[], task: Task): boolean {
  return findActionableTasksWithSameTitle(tasks, task).length > 1;
}

export function hasAmbiguousScheduledTitle(
  tasks: Task[],
  scheduleBlocks: ScheduleBlock[],
  taskId: string,
): boolean {
  const task = tasks.find((candidate) => candidate.id === taskId);

  if (!task) {
    return false;
  }

  const normalizedTitle = normalizeTaskTitle(task.title);
  let matchingScheduledCount = 0;

  for (const block of scheduleBlocks) {
    const scheduledTask = tasks.find(
      (candidate) => candidate.id === block.taskId,
    );

    if (
      scheduledTask &&
      normalizeTaskTitle(scheduledTask.title) === normalizedTitle
    ) {
      matchingScheduledCount += 1;
    }
  }

  return matchingScheduledCount > 1;
}

export function findActionableTasksWithSameTitle(
  tasks: Task[],
  task: Task,
): Task[] {
  const normalizedTitle = normalizeTaskTitle(task.title);

  return tasks.filter(
    (candidate) =>
      isTaskActionable(candidate) &&
      normalizeTaskTitle(candidate.title) === normalizedTitle,
  );
}

export function findScheduledTasksWithSameTitle(
  tasks: Task[],
  scheduleBlocks: ScheduleBlock[],
  taskId: string,
): Task[] {
  const task = tasks.find((candidate) => candidate.id === taskId);

  if (!task) {
    return [];
  }

  const normalizedTitle = normalizeTaskTitle(task.title);

  return scheduleBlocks.flatMap((block) => {
    const scheduledTask = tasks.find(
      (candidate) => candidate.id === block.taskId,
    );

    if (
      scheduledTask &&
      normalizeTaskTitle(scheduledTask.title) === normalizedTitle
    ) {
      return [scheduledTask];
    }

    return [];
  });
}

export function buildAmbiguousTaskReply(input: {
  tasks: Task[];
  title: string;
  actionPrompt: "update" | "move";
  timeZone: string;
}): string {
  const header =
    input.actionPrompt === "move"
      ? `I found multiple scheduled tasks named '${input.title}'. Tell me which one you want me to move:`
      : `I found multiple tasks named '${input.title}'. Tell me which one you want me to update:`;

  return `${header}\n${input.tasks
    .map(
      (task, index) =>
        `${index + 1}. ${describeTaskOption(task, input.timeZone)}`,
    )
    .join("\n")}`;
}

function normalizeTaskTitle(title: string): string {
  return title.trim().toLocaleLowerCase();
}

function isTaskActionable(task: Task): boolean {
  return task.lifecycleState !== "done" && task.lifecycleState !== "archived";
}

function describeTaskOption(task: Task, timeZone: string): string {
  if (task.scheduledStartAt) {
    return `scheduled for ${formatClarificationTime(task.scheduledStartAt, timeZone)}`;
  }

  if (task.lifecycleState === "pending_schedule") {
    return "not scheduled yet";
  }

  if (task.lifecycleState === "awaiting_followup") {
    return "waiting for follow-up";
  }

  return task.lifecycleState.replaceAll("_", " ");
}

function formatClarificationTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
```

- [ ] **Step 2: Update `process-inbox-item.ts` to import from new module**

Replace the inline function definitions with imports:

```ts
import {
  buildAmbiguousTaskReply,
  findActionableTasksWithSameTitle,
  findScheduledTasksWithSameTitle,
  hasAmbiguousScheduledTitle,
  hasAmbiguousTaskTitle,
} from "./ambiguous-title";
```

Remove the corresponding function bodies, `normalizeTaskTitle`, `isTaskActionable`, `describeTaskOption`, and `formatClarificationTime` from `process-inbox-item.ts`.

- [ ] **Step 3: Run existing tests**

Run: `pnpm --filter @atlas/web test -- --run process-inbox-item`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/server/ambiguous-title.ts apps/web/src/lib/server/process-inbox-item.ts
git commit -m "refactor: extract ambiguous-title helpers from process-inbox-item"
```

---

### Task 5: Policy simplification — remove `recover_and_execute`

**Files:**
- Modify: `packages/core/src/index.ts` (remove `recover_and_execute` from `TurnPolicyAction`, remove `mutationInputSource` from `TurnPolicyDecision`)
- Modify: `apps/web/src/lib/server/decide-turn-policy.ts` (confirmations produce `execute_mutation`)
- Modify: `apps/web/src/lib/server/decide-turn-policy.test.ts`

- [ ] **Step 1: Update decide-turn-policy tests**

In `apps/web/src/lib/server/decide-turn-policy.test.ts`, find tests that expect `action: "recover_and_execute"`. Change expected action to `"execute_mutation"`. Remove assertions on `mutationInputSource`. Add assertion that `resolvedOperation` is present (the rehydrated PendingWriteOperation).

For example, the confirmation test case at the `recover_and_execute` assertion should become:

```ts
expect(result.action).toBe("execute_mutation");
expect(result.requiresWrite).toBe(true);
expect(result.useMutationPipeline).toBe(true);
expect(result.resolvedOperation).toBeDefined();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atlas/web test -- --run decide-turn-policy`
Expected: FAIL — tests expect `execute_mutation` but get `recover_and_execute`

- [ ] **Step 3: Remove `recover_and_execute` from schema**

In `packages/core/src/index.ts`, find `turnPolicyActionSchema` and remove `"recover_and_execute"` from the enum values.

Remove `mutationInputSource` from `turnPolicyDecisionSchema`.

Also remove `"recover_and_execute"` from the `policyAction` enum on `conversationProposalOptionEntitySchema.data`.

Also remove `mutationInputSource` from `conversationProposalOptionEntitySchema.data`.

- [ ] **Step 4: Update `decide-turn-policy.ts` confirmation branch**

In `apps/web/src/lib/server/decide-turn-policy.ts`, replace the `recover_and_execute` branch (lines 75-86) with proposal rehydration logic. The confirmation case should:

1. Look up the proposal entity from `input.routingContext.entityRegistry`
2. Rehydrate `PendingWriteOperation` from `data.fieldSnapshot`, `data.targetEntityId`, `data.operationKind`, and `data.originatingTurnText`
3. Return `execute_mutation` with `resolvedOperation` set

```ts
case "confirmation": {
  const proposalId =
    input.resolvedProposalId ??
    resolveSingleActiveProposalId(
      input.routingContext.entityRegistry ?? [],
    );

  if (proposalId) {
    const proposalEntity = (input.routingContext.entityRegistry ?? []).find(
      (e) => e.kind === "proposal_option" && e.id === proposalId,
    );

    if (proposalEntity && proposalEntity.kind === "proposal_option") {
      const rehydrated = rehydratePendingWriteFromProposal(proposalEntity);

      if (rehydrated) {
        return {
          action: "execute_mutation",
          reason: "The turn confirms one recoverable pending proposal.",
          requiresWrite: true,
          requiresConfirmation: false,
          useMutationPipeline: true,
          targetProposalId: proposalId,
          ...(proposalEntity.data.targetEntityId
            ? { targetEntityId: proposalEntity.data.targetEntityId }
            : {}),
          resolvedOperation: rehydrated,
        };
      }
    }
  }

  return {
    action: "present_proposal",
    reason:
      "Confirmation language arrived but no recoverable proposal exists; present proposal now.",
    requiresWrite: true,
    requiresConfirmation: true,
    useMutationPipeline: false,
    clarificationSlots: [],
  };
}
```

Import `rehydratePendingWriteFromProposal` from `./rehydrate-proposal` (created in Task 6).

**Note:** Task 5 and Task 6 are coupled — Task 6 creates the rehydration function that Task 5 calls. Implement Task 6 first if needed, or stub the import initially.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @atlas/web test -- --run decide-turn-policy`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `pnpm --filter @atlas/core typecheck && pnpm --filter @atlas/web typecheck`
Expected: PASS (may surface downstream type errors from removing `recover_and_execute` — note them for Task 10)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts apps/web/src/lib/server/decide-turn-policy.ts apps/web/src/lib/server/decide-turn-policy.test.ts
git commit -m "feat: remove recover_and_execute, confirmations produce execute_mutation"
```

---

### Task 6: Proposal rehydration — `rehydratePendingWriteFromProposal`

**Files:**
- Create: `apps/web/src/lib/server/rehydrate-proposal.ts`
- Create: `apps/web/src/lib/server/rehydrate-proposal.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/server/rehydrate-proposal.test.ts
import { describe, expect, it } from "vitest";
import { rehydratePendingWriteFromProposal } from "./rehydrate-proposal";

describe("rehydratePendingWriteFromProposal", () => {
  const baseProposal = {
    id: "prop-1",
    conversationId: "conv-1",
    kind: "proposal_option" as const,
    label: "Schedule gym",
    status: "active" as const,
    createdAt: "2026-04-05T10:00:00Z",
    updatedAt: "2026-04-05T10:00:00Z",
    data: {
      route: "conversation_then_mutation" as const,
      replyText: "Schedule gym at 5pm?",
      fieldSnapshot: {
        scheduleFields: { day: "2026-04-06", time: { hour: 17, minute: 0 }, duration: 60 },
        taskFields: { priority: "medium" },
      },
      targetEntityId: "task-123",
      operationKind: "plan" as const,
      originatingTurnText: "schedule gym tomorrow at 5pm",
    },
  };

  it("rehydrates PendingWriteOperation from proposal with all fields", () => {
    const result = rehydratePendingWriteFromProposal(baseProposal);

    expect(result).not.toBeNull();
    expect(result!.operationKind).toBe("plan");
    expect(result!.targetRef).toEqual({
      entityId: "task-123",
      description: "Schedule gym",
      entityKind: null,
    });
    expect(result!.resolvedFields).toEqual(baseProposal.data.fieldSnapshot);
    expect(result!.originatingText).toBe("schedule gym tomorrow at 5pm");
    expect(result!.missingFields).toEqual([]);
  });

  it("returns null when proposal has no operationKind", () => {
    const proposal = {
      ...baseProposal,
      data: { ...baseProposal.data, operationKind: undefined },
    };
    const result = rehydratePendingWriteFromProposal(proposal as any);
    expect(result).toBeNull();
  });

  it("handles proposal with missing targetEntityId (new task)", () => {
    const proposal = {
      ...baseProposal,
      data: { ...baseProposal.data, targetEntityId: null },
    };
    const result = rehydratePendingWriteFromProposal(proposal);

    expect(result).not.toBeNull();
    expect(result!.targetRef).toEqual({
      entityId: null,
      description: "Schedule gym",
      entityKind: null,
    });
  });

  it("preserves missingFields from proposal data", () => {
    const proposal = {
      ...baseProposal,
      data: { ...baseProposal.data, missingFields: ["duration"] },
    };
    const result = rehydratePendingWriteFromProposal(proposal);

    expect(result).not.toBeNull();
    expect(result!.missingFields).toEqual(["duration"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atlas/web test -- --run rehydrate-proposal`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `rehydratePendingWriteFromProposal`**

```ts
// apps/web/src/lib/server/rehydrate-proposal.ts
import type { ConversationEntity, PendingWriteOperation } from "@atlas/core";

type ProposalEntity = Extract<ConversationEntity, { kind: "proposal_option" }>;

export function rehydratePendingWriteFromProposal(
  proposal: ProposalEntity,
): PendingWriteOperation | null {
  const { data } = proposal;

  if (!data.operationKind) {
    return null;
  }

  return {
    operationKind: data.operationKind,
    targetRef: {
      entityId: data.targetEntityId ?? null,
      description: proposal.label,
      entityKind: null,
    },
    resolvedFields: data.fieldSnapshot,
    missingFields: data.missingFields ?? [],
    originatingText: data.originatingTurnText ?? proposal.label,
    startedAt: proposal.createdAt,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @atlas/web test -- --run rehydrate-proposal`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/rehydrate-proposal.ts apps/web/src/lib/server/rehydrate-proposal.test.ts
git commit -m "feat: add proposal rehydration to PendingWriteOperation"
```

---

### Task 7: Update store method input types — drop `plannerRun`

**Files:**
- Modify: `packages/db/src/planner.ts` (remove `plannerRun` from all store input types, change return type from `ProcessedInboxResult` to `MutationResult`)

- [ ] **Step 1: Identify all store methods and their `plannerRun` usage**

The following methods in `InboxProcessingStore` (defined in `packages/db/src/planner.ts`) take `plannerRun`:
- `saveTaskCaptureResult`
- `saveScheduleRequestResult`
- `saveTaskCompletionResult`
- `saveScheduleAdjustmentResult`
- `saveTaskArchiveResult`
- `saveNeedsClarificationResult`

Each includes `plannerRun: Omit<PersistedPlannerRun, "id">` in its input.

- [ ] **Step 2: Remove `plannerRun` from store interface input types**

In `packages/db/src/planner.ts`, remove `plannerRun` from every store method's input parameter type. Also change all return types from `Promise<ProcessedInboxResult>` to `Promise<MutationResult>`.

Add import:
```ts
import type { MutationResult } from "@atlas/core";
```

Update the `InboxProcessingStore` interface. For example:

```ts
saveTaskCaptureResult(input: {
  inboxItemId: string;
  confidence: number;
  tasks: DraftTaskForPersistence[];
  scheduleBlocks: ScheduleBlock[];
  followUpMessage: string;
}): Promise<MutationResult>;
```

Apply the same pattern to all six methods.

- [ ] **Step 3: Update store implementations**

Find the concrete implementation of `InboxProcessingStore` (likely `getDefaultInboxProcessingStore()` in the same file or a nearby file). Remove `plannerRun` from each method's implementation. Update the return objects to match `MutationResult` discriminants:

| Old outcome | New outcome |
|---|---|
| `planned` | `created` |
| `scheduled_existing_tasks` | `scheduled` |
| `updated_schedule` | `rescheduled` |
| `completed_tasks` | `completed` |
| `archived_tasks` | `archived` |
| `needs_clarification` | `needs_clarification` |

Also rename task fields in the return:
| Old field | New field |
|---|---|
| `createdTasks` | `tasks` |
| `scheduledTasks` | `tasks` |
| `completedTasks` | `tasks` |
| `archivedTasks` | `tasks` |

Remove `inboxItem` and `plannerRun` from return objects.

- [ ] **Step 4: Remove `ProcessedInboxResult` type**

Remove the `ProcessedInboxResult` type from `packages/db/src/planner.ts`. Remove its export from `packages/db/src/index.ts`.

- [ ] **Step 5: Remove `PersistedPlannerRun` if unused**

Check if `PersistedPlannerRun` is used anywhere else. If only used by `ProcessedInboxResult` and the store methods that previously referenced it, remove it too.

- [ ] **Step 6: Run typecheck**

Run: `pnpm --filter @atlas/db typecheck`
Expected: PASS (or reveals downstream consumers that need updating — note for later tasks)

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/planner.ts packages/db/src/index.ts
git commit -m "refactor: drop plannerRun from store inputs, replace ProcessedInboxResult with MutationResult"
```

---

### Task 8: Build `executePendingWrite`

**Files:**
- Create: `apps/web/src/lib/server/execute-pending-write.ts`
- Create: `apps/web/src/lib/server/execute-pending-write.test.ts`

- [ ] **Step 1: Write the failing tests — plan (new task) happy path**

```ts
// apps/web/src/lib/server/execute-pending-write.test.ts
import { describe, expect, it, vi } from "vitest";
import type { MutationResult } from "@atlas/core";
import { executePendingWrite } from "./execute-pending-write";

function makeInput(overrides: Partial<Parameters<typeof executePendingWrite>[0]> = {}) {
  return {
    pendingWriteOperation: {
      operationKind: "plan" as const,
      targetRef: { entityId: null, description: "Go to gym", entityKind: null },
      resolvedFields: {
        scheduleFields: { day: "2026-04-06", time: { hour: 17, minute: 0 }, duration: 60 },
        taskFields: { priority: "medium" },
      },
      missingFields: [],
      originatingText: "schedule gym tomorrow at 5pm",
      startedAt: "2026-04-05T10:00:00Z",
    },
    userId: "user-1",
    tasks: [],
    scheduleBlocks: [],
    userProfile: { timezone: "America/Los_Angeles", userId: "user-1" },
    calendar: null,
    googleCalendarConnection: null,
    store: {
      saveTaskCaptureResult: vi.fn().mockResolvedValue({
        outcome: "created",
        tasks: [{ id: "task-new", title: "Go to gym", userId: "user-1", lifecycleState: "pending_schedule" }],
        scheduleBlocks: [],
        followUpMessage: "Saved.",
      } satisfies MutationResult),
      saveScheduleRequestResult: vi.fn(),
      saveTaskCompletionResult: vi.fn(),
      saveScheduleAdjustmentResult: vi.fn(),
      saveTaskArchiveResult: vi.fn(),
      saveNeedsClarificationResult: vi.fn(),
    },
    ...overrides,
  };
}

describe("executePendingWrite", () => {
  describe("plan — new task", () => {
    it("creates a task and returns created outcome", async () => {
      const input = makeInput();
      const result = await executePendingWrite(input);

      expect(result.outcome).toBe("created");
      expect(input.store.saveTaskCaptureResult).toHaveBeenCalledOnce();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @atlas/web test -- --run execute-pending-write`
Expected: FAIL — module not found

- [ ] **Step 3: Write the executor — plan (new task) branch**

```ts
// apps/web/src/lib/server/execute-pending-write.ts
import {
  buildCapturedTask,
  buildScheduleProposal,
  type MutationResult,
  type PendingWriteOperation,
  type ScheduleBlock,
  type Task,
  type UserProfile,
} from "@atlas/core";
import type { InboxProcessingStore } from "@atlas/db";
import type { ExternalCalendarAdapter } from "@atlas/integrations";
import type { GoogleCalendarConnection } from "@atlas/db";
import {
  buildRuntimeScheduleBlocks,
  scheduleTaskWithCalendar,
} from "./calendar-scheduling";
import {
  hasAmbiguousTaskTitle,
  hasAmbiguousScheduledTitle,
  buildAmbiguousTaskReply,
} from "./ambiguous-title";

export type ExecutePendingWriteInput = {
  pendingWriteOperation: PendingWriteOperation;
  userId: string;
  tasks: Task[];
  scheduleBlocks: ScheduleBlock[];
  userProfile: UserProfile;
  calendar: ExternalCalendarAdapter | null;
  googleCalendarConnection: GoogleCalendarConnection | null;
  store: InboxProcessingStore;
};

export async function executePendingWrite(
  input: ExecutePendingWriteInput,
): Promise<MutationResult> {
  const { pendingWriteOperation: op } = input;

  switch (op.operationKind) {
    case "plan":
      return op.targetRef?.entityId
        ? executeScheduleExisting(input)
        : executeCreateNew(input);
    case "reschedule":
      return executeReschedule(input);
    case "complete":
      return executeComplete(input);
    case "archive":
      return executeArchive(input);
    case "edit":
      return {
        outcome: "needs_clarification",
        reason: "Edit operations are not yet supported.",
        followUpMessage: "I can't edit tasks directly yet. Try telling me what you'd like to change.",
      };
    default: {
      const _exhaustive: never = op.operationKind;
      return {
        outcome: "needs_clarification",
        reason: `Unknown operation kind: ${op.operationKind}`,
        followUpMessage: "I'm not sure what to do with that request.",
      };
    }
  }
}

async function executeCreateNew(
  input: ExecutePendingWriteInput,
): Promise<MutationResult> {
  const { pendingWriteOperation: op, userProfile } = input;
  const title = op.targetRef?.description ?? op.originatingText;

  const task = buildCapturedTask({
    userId: input.userId,
    title,
    priority: op.resolvedFields.taskFields?.priority,
    label: op.resolvedFields.taskFields?.label,
    sourceText: op.resolvedFields.taskFields?.sourceText ?? op.originatingText,
  });

  const scheduleBlocks: ScheduleBlock[] = [];

  if (op.resolvedFields.scheduleFields && input.calendar) {
    const runtimeBlocks = await buildRuntimeScheduleBlocks({
      scheduleBlocks: input.scheduleBlocks,
      tasks: input.tasks,
      userId: input.userId,
      googleCalendarConnection: input.googleCalendarConnection,
      calendar: input.calendar,
      referenceTime: op.startedAt,
    });

    const proposal = await buildScheduleProposal({
      task: { ...task, id: "draft" },
      userProfile,
      scheduleConstraint: {
        day: op.resolvedFields.scheduleFields.day ?? null,
        time: op.resolvedFields.scheduleFields.time ?? null,
        duration: op.resolvedFields.scheduleFields.duration ?? null,
      },
      existingBlocks: runtimeBlocks,
      referenceTime: op.startedAt,
    });

    const [proposedBlock] = proposal.inserts;
    if (proposedBlock) {
      const scheduled = await scheduleTaskWithCalendar({
        calendar: input.calendar,
        task: { ...task, id: "draft" } as Task,
        selectedCalendarId:
          input.googleCalendarConnection?.selectedCalendarId ?? null,
        proposedBlock: {
          ...proposedBlock,
          taskId: "draft",
          externalCalendarId:
            input.googleCalendarConnection?.selectedCalendarId ??
            proposedBlock.externalCalendarId,
          reason: "New task scheduled",
        },
      });
      scheduleBlocks.push(scheduled);
    }
  }

  return input.store.saveTaskCaptureResult({
    inboxItemId: `exec:${op.startedAt}`,
    confidence: 1.0,
    tasks: [{ alias: "draft", task }],
    scheduleBlocks,
    followUpMessage: "",
  });
}

async function executeScheduleExisting(
  input: ExecutePendingWriteInput,
): Promise<MutationResult> {
  const { pendingWriteOperation: op, userProfile } = input;
  const targetTask = input.tasks.find(
    (t) => t.id === op.targetRef?.entityId,
  );

  if (!targetTask) {
    return {
      outcome: "needs_clarification",
      reason: `Could not find task with ID ${op.targetRef?.entityId}`,
      followUpMessage: "I couldn't find that task. Could you clarify which one you mean?",
    };
  }

  if (hasAmbiguousTaskTitle(input.tasks, targetTask)) {
    return {
      outcome: "needs_clarification",
      reason: "Ambiguous task title",
      followUpMessage: buildAmbiguousTaskReply({
        tasks: input.tasks.filter((t) => t.title === targetTask.title),
        title: targetTask.title,
        actionPrompt: "update",
        timeZone: userProfile.timezone,
      }),
    };
  }

  if (!input.calendar) {
    return {
      outcome: "needs_clarification",
      reason: "No calendar connected",
      followUpMessage: "Please connect Google Calendar before scheduling tasks.",
    };
  }

  const runtimeBlocks = await buildRuntimeScheduleBlocks({
    scheduleBlocks: input.scheduleBlocks,
    tasks: input.tasks,
    userId: input.userId,
    googleCalendarConnection: input.googleCalendarConnection,
    calendar: input.calendar,
    referenceTime: op.startedAt,
  });

  const proposal = await buildScheduleProposal({
    task: targetTask,
    userProfile,
    scheduleConstraint: {
      day: op.resolvedFields.scheduleFields?.day ?? null,
      time: op.resolvedFields.scheduleFields?.time ?? null,
      duration: op.resolvedFields.scheduleFields?.duration ?? null,
    },
    existingBlocks: runtimeBlocks,
    referenceTime: op.startedAt,
  });

  const [proposedBlock] = proposal.inserts;
  if (!proposedBlock) {
    return {
      outcome: "needs_clarification",
      reason: "Could not build a schedule proposal for this task.",
      followUpMessage: "I couldn't find a good time slot. Try specifying a different time.",
    };
  }

  const scheduled = await scheduleTaskWithCalendar({
    calendar: input.calendar,
    task: targetTask,
    selectedCalendarId:
      input.googleCalendarConnection?.selectedCalendarId ?? null,
    proposedBlock: {
      ...proposedBlock,
      taskId: targetTask.id,
      externalCalendarId:
        input.googleCalendarConnection?.selectedCalendarId ??
        proposedBlock.externalCalendarId,
      reason: "Scheduled existing task",
    },
  });

  return input.store.saveScheduleRequestResult({
    inboxItemId: `exec:${op.startedAt}`,
    confidence: 1.0,
    taskIds: [targetTask.id],
    scheduleBlocks: [scheduled],
    followUpMessage: "",
  });
}

async function executeReschedule(
  input: ExecutePendingWriteInput,
): Promise<MutationResult> {
  const { pendingWriteOperation: op, userProfile } = input;
  const targetTaskId = op.targetRef?.entityId;

  if (!targetTaskId) {
    return {
      outcome: "needs_clarification",
      reason: "No target task for reschedule",
      followUpMessage: "Which task would you like me to reschedule?",
    };
  }

  const existingBlock = input.scheduleBlocks.find(
    (b) => b.taskId === targetTaskId,
  );

  if (!existingBlock) {
    return {
      outcome: "needs_clarification",
      reason: `No schedule block found for task ${targetTaskId}`,
      followUpMessage: "That task doesn't have a scheduled time to move.",
    };
  }

  if (hasAmbiguousScheduledTitle(input.tasks, input.scheduleBlocks, targetTaskId)) {
    const targetTask = input.tasks.find((t) => t.id === targetTaskId);
    return {
      outcome: "needs_clarification",
      reason: "Ambiguous scheduled title",
      followUpMessage: buildAmbiguousTaskReply({
        tasks: input.tasks.filter(
          (t) => t.title === targetTask?.title,
        ),
        title: targetTask?.title ?? "Unknown",
        actionPrompt: "move",
        timeZone: userProfile.timezone,
      }),
    };
  }

  if (!input.calendar) {
    return {
      outcome: "needs_clarification",
      reason: "No calendar connected",
      followUpMessage: "Please connect Google Calendar before rescheduling.",
    };
  }

  const targetTask = input.tasks.find((t) => t.id === targetTaskId);
  if (targetTask) {
    const { detectTaskCalendarDrift } = await import("@atlas/core");
    const drift = await detectTaskCalendarDrift({
      task: targetTask,
      calendar: input.calendar,
    });
    if (drift?.hasDrift) {
      return {
        outcome: "needs_clarification",
        reason: "Calendar drift detected",
        followUpMessage:
          "The linked Google Calendar event changed outside Atlas. Please check the event and try again.",
      };
    }
  }

  const { buildScheduleAdjustment } = await import("@atlas/core");
  const adjustment = buildScheduleAdjustment({
    block: existingBlock,
    userProfile,
    scheduleConstraint: op.resolvedFields.scheduleFields
      ? {
          day: op.resolvedFields.scheduleFields.day ?? null,
          time: op.resolvedFields.scheduleFields.time ?? null,
          duration: op.resolvedFields.scheduleFields.duration ?? null,
        }
      : null,
    existingBlocks: input.scheduleBlocks,
    referenceTime: op.startedAt,
  });

  return input.store.saveScheduleAdjustmentResult({
    inboxItemId: `exec:${op.startedAt}`,
    confidence: 1.0,
    blockId: adjustment.blockId,
    newStartAt: adjustment.newStartAt,
    newEndAt: adjustment.newEndAt,
    reason: adjustment.reason,
    followUpMessage: "",
  });
}

async function executeComplete(
  input: ExecutePendingWriteInput,
): Promise<MutationResult> {
  const { pendingWriteOperation: op, userProfile } = input;
  const targetTaskId = op.targetRef?.entityId;

  if (!targetTaskId) {
    return {
      outcome: "needs_clarification",
      reason: "No target task for completion",
      followUpMessage: "Which task would you like me to mark as done?",
    };
  }

  const targetTask = input.tasks.find((t) => t.id === targetTaskId);

  if (!targetTask) {
    return {
      outcome: "needs_clarification",
      reason: `Could not find task with ID ${targetTaskId}`,
      followUpMessage: "I couldn't find that task. Could you clarify which one you mean?",
    };
  }

  if (hasAmbiguousTaskTitle(input.tasks, targetTask)) {
    return {
      outcome: "needs_clarification",
      reason: "Ambiguous task title",
      followUpMessage: buildAmbiguousTaskReply({
        tasks: input.tasks.filter((t) => t.title === targetTask.title),
        title: targetTask.title,
        actionPrompt: "update",
        timeZone: userProfile.timezone,
      }),
    };
  }

  return input.store.saveTaskCompletionResult({
    inboxItemId: `exec:${op.startedAt}`,
    confidence: 1.0,
    taskIds: [targetTaskId],
    followUpMessage: "",
  });
}

async function executeArchive(
  input: ExecutePendingWriteInput,
): Promise<MutationResult> {
  const { pendingWriteOperation: op, userProfile } = input;
  const targetTaskId = op.targetRef?.entityId;

  if (!targetTaskId) {
    return {
      outcome: "needs_clarification",
      reason: "No target task for archival",
      followUpMessage: "Which task would you like me to archive?",
    };
  }

  const targetTask = input.tasks.find((t) => t.id === targetTaskId);

  if (!targetTask) {
    return {
      outcome: "needs_clarification",
      reason: `Could not find task with ID ${targetTaskId}`,
      followUpMessage: "I couldn't find that task. Could you clarify which one you mean?",
    };
  }

  if (hasAmbiguousTaskTitle(input.tasks, targetTask)) {
    return {
      outcome: "needs_clarification",
      reason: "Ambiguous task title",
      followUpMessage: buildAmbiguousTaskReply({
        tasks: input.tasks.filter((t) => t.title === targetTask.title),
        title: targetTask.title,
        actionPrompt: "update",
        timeZone: userProfile.timezone,
      }),
    };
  }

  return input.store.saveTaskArchiveResult({
    inboxItemId: `exec:${op.startedAt}`,
    confidence: 1.0,
    taskIds: [targetTaskId],
    followUpMessage: "",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @atlas/web test -- --run execute-pending-write`
Expected: PASS

- [ ] **Step 5: Write remaining happy-path tests**

Add tests for each operation kind to `execute-pending-write.test.ts`:

```ts
  describe("plan — schedule existing task", () => {
    it("schedules an existing task and returns scheduled outcome", async () => {
      const existingTask = {
        id: "task-123",
        title: "Go to gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
        scheduledStartAt: null,
        scheduledEndAt: null,
        externalCalendarId: null,
        externalCalendarEventId: null,
      } as any;

      const mockCalendar = {
        provider: "google-calendar" as const,
        createEvent: vi.fn().mockResolvedValue({
          externalCalendarEventId: "gcal-1",
          externalCalendarId: "cal-1",
          scheduledStartAt: "2026-04-06T17:00:00Z",
          scheduledEndAt: "2026-04-06T18:00:00Z",
        }),
        updateEvent: vi.fn(),
        getEvent: vi.fn().mockResolvedValue(null),
        listBusyPeriods: vi.fn().mockResolvedValue([]),
      };

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "plan",
          targetRef: { entityId: "task-123", description: "Go to gym", entityKind: null },
          resolvedFields: {
            scheduleFields: { day: "2026-04-06", time: { hour: 17, minute: 0 }, duration: 60 },
          },
          missingFields: [],
          originatingText: "schedule gym tomorrow",
          startedAt: "2026-04-05T10:00:00Z",
        },
        tasks: [existingTask],
        calendar: mockCalendar,
        googleCalendarConnection: { selectedCalendarId: "cal-1" } as any,
        store: {
          ...makeInput().store,
          saveScheduleRequestResult: vi.fn().mockResolvedValue({
            outcome: "scheduled",
            tasks: [existingTask],
            scheduleBlocks: [],
            followUpMessage: "Scheduled.",
          } satisfies MutationResult),
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("scheduled");
      expect(input.store.saveScheduleRequestResult).toHaveBeenCalledOnce();
    });
  });

  describe("complete", () => {
    it("completes a task and returns completed outcome", async () => {
      const existingTask = {
        id: "task-123",
        title: "Go to gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
      } as any;

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "complete",
          targetRef: { entityId: "task-123", description: "Go to gym", entityKind: null },
          resolvedFields: {},
          missingFields: [],
          originatingText: "mark gym as done",
          startedAt: "2026-04-05T10:00:00Z",
        },
        tasks: [existingTask],
        store: {
          ...makeInput().store,
          saveTaskCompletionResult: vi.fn().mockResolvedValue({
            outcome: "completed",
            tasks: [{ ...existingTask, lifecycleState: "done" }],
            followUpMessage: "Done.",
          } satisfies MutationResult),
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("completed");
      expect(input.store.saveTaskCompletionResult).toHaveBeenCalledOnce();
    });
  });

  describe("archive", () => {
    it("archives a task and returns archived outcome", async () => {
      const existingTask = {
        id: "task-123",
        title: "Go to gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
      } as any;

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "archive",
          targetRef: { entityId: "task-123", description: "Go to gym", entityKind: null },
          resolvedFields: {},
          missingFields: [],
          originatingText: "archive gym",
          startedAt: "2026-04-05T10:00:00Z",
        },
        tasks: [existingTask],
        store: {
          ...makeInput().store,
          saveTaskArchiveResult: vi.fn().mockResolvedValue({
            outcome: "archived",
            tasks: [{ ...existingTask, lifecycleState: "archived" }],
            followUpMessage: "Archived.",
          } satisfies MutationResult),
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("archived");
      expect(input.store.saveTaskArchiveResult).toHaveBeenCalledOnce();
    });
  });

  describe("edit (deferred)", () => {
    it("returns needs_clarification for edit operations", async () => {
      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "edit",
          targetRef: { entityId: "task-123", description: "Go to gym", entityKind: null },
          resolvedFields: {},
          missingFields: [],
          originatingText: "edit gym",
          startedAt: "2026-04-05T10:00:00Z",
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
    });
  });
```

- [ ] **Step 6: Write clarification fallback tests**

```ts
  describe("clarification fallbacks", () => {
    it("returns needs_clarification when target task not found", async () => {
      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "complete",
          targetRef: { entityId: "nonexistent", description: "???", entityKind: null },
          resolvedFields: {},
          missingFields: [],
          originatingText: "done",
          startedAt: "2026-04-05T10:00:00Z",
        },
        tasks: [],
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
    });

    it("returns needs_clarification for ambiguous task title", async () => {
      const tasks = [
        { id: "t1", title: "Gym", userId: "user-1", lifecycleState: "pending_schedule" },
        { id: "t2", title: "Gym", userId: "user-1", lifecycleState: "pending_schedule" },
      ] as any[];

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "complete",
          targetRef: { entityId: "t1", description: "Gym", entityKind: null },
          resolvedFields: {},
          missingFields: [],
          originatingText: "done with gym",
          startedAt: "2026-04-05T10:00:00Z",
        },
        tasks,
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
      expect(result.followUpMessage).toContain("multiple tasks");
    });

    it("returns needs_clarification when no calendar for scheduling", async () => {
      const existingTask = {
        id: "task-123",
        title: "Gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
      } as any;

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "plan",
          targetRef: { entityId: "task-123", description: "Gym", entityKind: null },
          resolvedFields: { scheduleFields: { day: "2026-04-06" } },
          missingFields: [],
          originatingText: "schedule gym",
          startedAt: "2026-04-05T10:00:00Z",
        },
        tasks: [existingTask],
        calendar: null,
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
      expect(result.followUpMessage).toContain("calendar");
    });
  });
```

- [ ] **Step 7: Run all executor tests**

Run: `pnpm --filter @atlas/web test -- --run execute-pending-write`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/server/execute-pending-write.ts apps/web/src/lib/server/execute-pending-write.test.ts
git commit -m "feat: add deterministic mutation executor"
```

---

### Task 9: Update `mutation-reply.ts` to accept `MutationResult`

**Files:**
- Modify: `apps/web/src/lib/server/mutation-reply.ts`
- Modify: `apps/web/src/lib/server/mutation-reply.test.ts`

- [ ] **Step 1: Update tests to use `MutationResult` discriminants**

In `apps/web/src/lib/server/mutation-reply.test.ts`, change imports from `ProcessedInboxResult` (from `@atlas/db`) to `MutationResult` (from `@atlas/core`). Update test fixtures:

| Old outcome | New outcome | Old field | New field |
|---|---|---|---|
| `planned` | `created` | `createdTasks` | `tasks` |
| `scheduled_existing_tasks` | `scheduled` | `scheduledTasks` | `tasks` |
| `updated_schedule` | `rescheduled` | — | — |
| `completed_tasks` | `completed` | `completedTasks` | `tasks` |
| `archived_tasks` | `archived` | `archivedTasks` | `tasks` |
| `needs_clarification` | `needs_clarification` | — | — |

Remove `inboxItem` and `plannerRun` from all test fixtures.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atlas/web test -- --run mutation-reply`
Expected: FAIL

- [ ] **Step 3: Update `mutation-reply.ts`**

Change the import and function signature:

```ts
import type { MutationResult } from "@atlas/core";

export function renderMutationReply(
  result: MutationResult,
  options: { timeZone?: string } = {},
): string {
```

Update the switch cases:
- `"planned"` → `"created"`, use `result.tasks`
- `"scheduled_existing_tasks"` → `"scheduled"`, use `result.tasks`
- `"updated_schedule"` → `"rescheduled"`
- `"completed_tasks"` → `"completed"`, use `result.tasks`
- `"archived_tasks"` → `"archived"`, use `result.tasks`
- `"needs_clarification"` stays the same

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @atlas/web test -- --run mutation-reply`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/mutation-reply.ts apps/web/src/lib/server/mutation-reply.test.ts
git commit -m "refactor: mutation-reply accepts MutationResult instead of ProcessedInboxResult"
```

---

### Task 10: Update `conversation-state.ts` to consume `MutationResult`

**Files:**
- Modify: `apps/web/src/lib/server/conversation-state.ts`
- Modify: `apps/web/src/lib/server/conversation-state.test.ts`

- [ ] **Step 1: Update tests**

In `apps/web/src/lib/server/conversation-state.test.ts`, change test fixtures to use `MutationResult` discriminants:

| Old | New |
|---|---|
| `outcome: "planned"`, `createdTasks` | `outcome: "created"`, `tasks` |
| `outcome: "scheduled_existing_tasks"`, `scheduledTasks` | `outcome: "scheduled"`, `tasks` |
| `outcome: "updated_schedule"` | `outcome: "rescheduled"` |
| `outcome: "completed_tasks"`, `completedTasks` | `outcome: "completed"`, `tasks` |
| `outcome: "archived_tasks"`, `archivedTasks` | `outcome: "archived"`, `tasks` |

Remove `inboxItem` and `plannerRun` from all test fixtures.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atlas/web test -- --run conversation-state`
Expected: FAIL

- [ ] **Step 3: Update `conversation-state.ts`**

Change import:
```ts
import type { MutationResult } from "@atlas/core";
// Remove: import type { ProcessedInboxResult } from "@atlas/db";
```

Update `DeriveMutationStateInput`:
```ts
type DeriveMutationStateInput = {
  snapshot: ConversationStateSnapshot;
  processing: MutationResult;
  occurredAt?: string;
};
```

Update `selectTasks`:
```ts
function selectTasks(processing: MutationResult): Task[] {
  switch (processing.outcome) {
    case "created":
    case "scheduled":
    case "completed":
    case "archived":
      return processing.tasks;
    default:
      return [];
  }
}
```

Update `selectScheduleBlocks`:
```ts
function selectScheduleBlocks(processing: MutationResult): ScheduleBlock[] {
  switch (processing.outcome) {
    case "created":
    case "scheduled":
      return processing.scheduleBlocks;
    case "rescheduled":
      return [processing.updatedBlock];
    default:
      return [];
  }
}
```

Update `findTaskTitleForBlock`:
```ts
function findTaskTitleForBlock(block: ScheduleBlock, processing: MutationResult) {
  return (
    selectTasks(processing).find((task) => task.id === block.taskId)?.title ??
    "Scheduled work"
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @atlas/web test -- --run conversation-state`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/conversation-state.ts apps/web/src/lib/server/conversation-state.test.ts
git commit -m "refactor: deriveMutationState consumes MutationResult"
```

---

### Task 11: Webhook wiring — collapse mutation branches

**Files:**
- Modify: `apps/web/src/lib/server/telegram-webhook.ts`
- Modify: `apps/web/src/lib/server/telegram-webhook.test.ts` (if exists)

- [ ] **Step 1: Update webhook tests**

In the webhook test file, replace mocks of `processInboxItem` with mocks of `executePendingWrite`. Update test assertions:
- Remove tests that assert `synthesizeMutationText` calls
- Remove tests for `recover_and_execute` branch (now handled by `execute_mutation`)
- Both the `recover_and_execute` and `execute_mutation` branches should now be a single `execute_mutation` branch calling `executePendingWrite`

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atlas/web test -- --run telegram-webhook`
Expected: FAIL

- [ ] **Step 3: Update `telegram-webhook.ts`**

Remove imports:
```ts
// Remove:
import { processInboxItem } from "./process-inbox-item";
import { synthesizeMutationText } from "@atlas/core";
```

Add import:
```ts
import { executePendingWrite } from "./execute-pending-write";
```

Replace the two mutation branches (the `recover_and_execute` block at ~line 443 and the `execute_mutation` block at ~line 609) with a single block:

```ts
if (
  routedWithContext.policy.action === "execute_mutation"
) {
  console.info("turn_execution_branch", {
    userId: normalizedMessage.user.telegramUserId,
    action: routedWithContext.policy.action,
  });

  await dependencies.primeProcessingStore?.(ingress.inboxItem);

  const resolvedOperation = routedWithContext.policy.resolvedOperation;
  if (!resolvedOperation) {
    // Fallback — should not happen if policy is correct
    return replyWithText(
      {
        userId: normalizedMessage.user.telegramUserId,
        chatId: normalizedMessage.chatId,
        inboxItemId: ingress.inboxItem.id,
        text: "I need a bit more detail to proceed.",
      },
      {
        editor: dependencies.editor ?? editTelegramMessage,
        placeholderDelivery,
        sender: dependencies.sender ?? sendTelegramMessage,
        ...(dependencies.deliveryStore
          ? { deliveryStore: dependencies.deliveryStore }
          : {}),
        body: {
          accepted: true,
          idempotencyKey,
          ingestion: normalizedMessage,
          inboxItem: ingress.inboxItem,
          turnRoute: compatibilityTurnRoute,
          routing: routedWithContext,
          processing: { outcome: "needs_clarification" },
        },
      },
    );
  }

  const processing = await executePendingWrite({
    pendingWriteOperation: resolvedOperation,
    userId: normalizedMessage.user.telegramUserId,
    tasks: routedWithContext.routingContext.tasks ?? [],
    scheduleBlocks: routedWithContext.routingContext.scheduleBlocks ?? [],
    userProfile: routedWithContext.routingContext.userProfile,
    calendar: dependencies.calendar ?? null,
    googleCalendarConnection:
      routedWithContext.routingContext.googleCalendarConnection ?? null,
    store: dependencies.store ?? getDefaultInboxProcessingStore(),
  });

  const outboundDelivery = await finalizeFollowUpMessage(
    {
      userId: normalizedMessage.user.telegramUserId,
      chatId: normalizedMessage.chatId,
      inboxItemId: ingress.inboxItem.id,
      text: processing.followUpMessage,
    },
    {
      editor: dependencies.editor ?? editTelegramMessage,
      placeholderDelivery,
      sender: dependencies.sender ?? sendTelegramMessage,
      ...(dependencies.deliveryStore
        ? { deliveryStore: dependencies.deliveryStore }
        : {}),
    },
  );
  const followUpContinuation = await maybeSendOutstandingFollowUpContinuation(
    {
      userId: normalizedMessage.user.telegramUserId,
      chatId: normalizedMessage.chatId,
      inboxItemId: ingress.inboxItem.id,
    },
    dependencies,
  );

  if (conversationState) {
    await appendConversationTurn(
      {
        userId: normalizedMessage.user.telegramUserId,
        role: "assistant",
        text: processing.followUpMessage,
      },
      dependencies.conversationStateStore,
    );
    await saveConversationState(
      {
        userId: normalizedMessage.user.telegramUserId,
        ...deriveMutationState({
          snapshot: conversationState,
          processing,
        }),
      },
      dependencies.conversationStateStore,
    );
  }

  return {
    status: 200,
    body: {
      accepted: true,
      idempotencyKey,
      ingestion: normalizedMessage,
      inboxItem: ingress.inboxItem,
      turnRoute: compatibilityTurnRoute,
      routing: routedWithContext,
      processing,
      outboundDelivery,
      followUpContinuation,
    },
  };
}
```

Also remove `recover_and_execute` from the `getPlaceholderTextForAction` helper and the `compatibilityTurnRoute` mapper (or map it to the same as `execute_mutation`).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @atlas/web test -- --run telegram-webhook`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/telegram-webhook.ts apps/web/src/lib/server/telegram-webhook.test.ts
git commit -m "feat: collapse webhook mutation branches to single executePendingWrite call"
```

---

### Task 12: Delete obsolete modules

**Files to delete:**
- `apps/web/src/lib/server/process-inbox-item.ts`
- `apps/web/src/lib/server/process-inbox-item.test.ts`
- `packages/integrations/src/prompts/planner.ts`
- `packages/integrations/src/manual/planner.eval-suite.ts`
- `packages/core/src/synthesize-mutation-text.ts`
- Tests for `synthesize-mutation-text.ts` (find with `grep -r "synthesize-mutation-text" --include="*.test.ts"`)

- [ ] **Step 1: Remove imports of deleted modules**

Search for all imports of:
- `processInboxItem` / `ProcessInboxItemRequest` / `ProcessInboxItemDependencies`
- `planInboxItemWithResponses` / `recoverConfirmedMutationWithResponses`
- `synthesizeMutationText` / `SynthesizeMutationTextInput` / `SynthesizeMutationTextResult`
- `ProcessedInboxResult`
- `inboxPlannerSystemPrompt`

Remove these imports from all files. Remove re-exports from `packages/integrations/src/index.ts` and `packages/core/src/index.ts`.

- [ ] **Step 2: Delete the files**

```bash
rm apps/web/src/lib/server/process-inbox-item.ts
rm apps/web/src/lib/server/process-inbox-item.test.ts
rm packages/integrations/src/prompts/planner.ts
rm packages/integrations/src/manual/planner.eval-suite.ts
rm packages/core/src/synthesize-mutation-text.ts
# Find and delete synthesize-mutation-text tests:
find . -name "*.test.ts" -path "*/synthesize-mutation-text*" -delete
```

- [ ] **Step 3: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS — no remaining references to deleted modules

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete obsolete planner LLM, processInboxItem, and synthesizeMutationText"
```

---

### Task 13: Final verification and cleanup

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 4: Verify no remaining references to removed symbols**

```bash
grep -rn "ProcessedInboxResult\|planInboxItemWithResponses\|recoverConfirmedMutationWithResponses\|synthesizeMutationText\|recover_and_execute\|mutationInputSource\|plannerRun" --include="*.ts" packages/ apps/ | grep -v node_modules | grep -v ".test.ts" | grep -v ".worktrees/"
```

Expected: No matches (or only in test fixtures that are acceptable)

- [ ] **Step 5: Commit any cleanup**

```bash
git add -A
git commit -m "chore: final cleanup after deterministic mutation executor migration"
```
