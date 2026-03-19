import {
  buildBusyScheduleBlocks,
  buildCapturedTask,
  buildInboxPlanningContext,
  buildScheduleAdjustment,
  buildScheduleProposal,
  detectTaskCalendarDrift,
  resolveScheduleBlockReference,
  resolveTaskReference,
  type InboxPlanningContext,
  type InboxPlanningOutput,
  type PlanningAction,
  type ScheduleBlock,
  type Task
} from "@atlas/core";
import {
  getDefaultInboxProcessingStore,
  type DraftTaskForPersistence,
  type InboxProcessingStore,
  type ProcessedInboxResult
} from "@atlas/db";
import {
  planInboxItemWithResponses,
  type CalendarEventSnapshot,
  type CalendarBusyPeriod,
  type ExternalCalendarAdapter
} from "@atlas/integrations";
import { renderMutationReply } from "./mutation-reply";
import { resolveGoogleCalendarAdapter } from "./google-calendar";

export type ProcessInboxItemRequest = {
  inboxItemId: string;
  planningInboxTextOverride?: {
    text: string;
  };
};

export type ProcessInboxItemDependencies = {
  store?: InboxProcessingStore;
  planner?: typeof planInboxItemWithResponses;
  calendar?: ExternalCalendarAdapter | null;
};

const CALENDAR_BUSY_LOOKAHEAD_DAYS = 14;

export async function processInboxItem(
  input: ProcessInboxItemRequest,
  dependencies: ProcessInboxItemDependencies = {}
): Promise<ProcessedInboxResult> {
  const parsed = parseProcessInboxItemRequest(input);
  const store = dependencies.store ?? getDefaultInboxProcessingStore();
  const planner = dependencies.planner ?? planInboxItemWithResponses;
  const context = await store.loadContext(parsed.inboxItemId);

  if (!context) {
    throw new Error(`Inbox item ${parsed.inboxItemId} not found.`);
  }

  await store.markInboxProcessing(parsed.inboxItemId);

  const planningContext = buildInboxPlanningContext({
    inboxItem: input.planningInboxTextOverride
      ? {
          ...context.inboxItem,
          rawText: input.planningInboxTextOverride.text,
          normalizedText: input.planningInboxTextOverride.text
        }
      : context.inboxItem,
    userProfile: context.userProfile,
    tasks: context.tasks,
    scheduleBlocks: context.scheduleBlocks
  });

  let planning: InboxPlanningOutput;

  try {
    planning = await planner(planningContext);
  } catch (error) {
    await store.saveFailedPlannerRun({
      inboxItemId: context.inboxItem.id,
      plannerRun: buildPlannerRun(context, planningContext, {
        failure: buildErrorEnvelope(error)
      })
    });
    throw error;
  }

  const plannerRun = buildPlannerRun(context, planningContext, planning);

  try {
    const calendar =
      dependencies.calendar !== undefined
        ? dependencies.calendar
        : context.googleCalendarConnection
          ? (
              await resolveGoogleCalendarAdapter(context.googleCalendarConnection)
            ).adapter
          : null;

    return await applyPlanningResult({
      context,
      planningContext,
      planning,
      plannerRun,
      store,
      calendar
    });
  } catch (error) {
    await store.saveFailedPlannerRun({
      inboxItemId: context.inboxItem.id,
      plannerRun: buildPlannerRun(context, planningContext, {
        ...planning,
        failure: buildErrorEnvelope(error)
      })
    });
    throw error;
  }
}

type ApplyPlanningResultInput = {
  context: Awaited<ReturnType<InboxProcessingStore["loadContext"]>> extends infer T
    ? Exclude<T, null>
    : never;
  planningContext: InboxPlanningContext;
  planning: InboxPlanningOutput;
  plannerRun: {
    userId: string;
    inboxItemId: string;
    version: string;
    modelInput: unknown;
    modelOutput: unknown;
    confidence: number;
  };
  store: InboxProcessingStore;
  calendar: ExternalCalendarAdapter | null;
};

async function applyPlanningResult(input: ApplyPlanningResultInput): Promise<ProcessedInboxResult> {
  const actions = input.planning.actions;
  const clarifyAction = actions.find((action) => action.type === "clarify");
  const createTaskActions = actions.filter((action) => action.type === "create_task");
  const createScheduleActions = actions.filter((action) => action.type === "create_schedule_block");
  const moveActions = actions.filter((action) => action.type === "move_schedule_block");

  if (clarifyAction) {
    if (actions.length > 1) {
      return saveClarification(input, "Model returned clarify alongside mutating actions.");
    }

    return withRenderedFollowUp(
      await input.store.saveNeedsClarificationResult({
      inboxItemId: input.context.inboxItem.id,
      confidence: input.planning.confidence,
      plannerRun: input.plannerRun,
      reason: clarifyAction.reason,
      followUpMessage: ""
    }),
      input.context.userProfile.timezone
    );
  }

  if (moveActions.length > 0) {
    if (moveActions.length !== 1 || createTaskActions.length > 0 || createScheduleActions.length > 0) {
      return saveClarification(input, "Model returned an unsupported mix of move and create actions.");
    }

    if (!input.calendar) {
      return saveClarification(input, "Please connect Google Calendar before moving scheduled work.");
    }

    const moveAction = moveActions[0];

    if (!moveAction) {
      return saveClarification(input, "Model did not provide a valid move action.");
    }

    return applyMoveAction(input, moveAction);
  }

  if (createTaskActions.length > 0) {
    if (!input.calendar) {
      return saveClarification(input, "Please connect Google Calendar before scheduling tasks.");
    }

    return applyCreatedTaskActions(input, createTaskActions, createScheduleActions);
  }

  if (createScheduleActions.length > 0) {
    if (!input.calendar) {
      return saveClarification(input, "Please connect Google Calendar before scheduling tasks.");
    }

    return applyExistingTaskScheduleActions(input, createScheduleActions);
  }

  return saveClarification(input, "Model returned no actionable planning actions.");
}

async function applyCreatedTaskActions(
  input: ApplyPlanningResultInput,
  createTaskActions: Extract<PlanningAction, { type: "create_task" }>[],
  createScheduleActions: Extract<PlanningAction, { type: "create_schedule_block" }>[]
) {
  if (!input.calendar) {
    return saveClarification(input, "Please connect Google Calendar before scheduling tasks.");
  }

  const createdTaskAliases = new Set(createTaskActions.map((action) => action.alias));
  const scheduleActionsForCreatedTasks = createScheduleActions.filter(
    (action) => action.taskRef.kind === "created_task"
  );
  const invalidCreatedTaskReferences = scheduleActionsForCreatedTasks.some(
    (action) => !createdTaskAliases.has(action.taskRef.alias)
  );
  const hasExistingTaskReferences = createScheduleActions.some((action) => action.taskRef.kind === "existing_task");

  if (invalidCreatedTaskReferences || hasExistingTaskReferences) {
    return saveClarification(
      input,
      "Model returned invalid or mixed schedule references for newly created tasks."
    );
  }

  if (scheduleActionsForCreatedTasks.length !== createTaskActions.length) {
    return saveClarification(
      input,
      "Each created task must have exactly one schedule action in schedule-forward mode."
    );
  }

  const draftTasks: DraftTaskForPersistence[] = createTaskActions.map((action) => ({
    alias: action.alias,
    task: buildCapturedTask({
      userId: input.context.inboxItem.userId,
      inboxItemId: input.context.inboxItem.id,
      title: action.title,
      priority: action.priority,
      urgency: action.urgency
    })
  }));
  const taskAliasToDraftTask = new Map<string, Task>(
    draftTasks.map(({ alias, task }) => [
      alias,
      {
        id: alias,
        ...task
      }
    ])
  );
  const scheduleBlocks = await buildScheduleBlocksForCreatedTasks(
    input.context,
    scheduleActionsForCreatedTasks,
    taskAliasToDraftTask,
    input.calendar
  );

  if ("reason" in scheduleBlocks) {
    return saveClarification(input, scheduleBlocks.reason);
  }

  return withRenderedFollowUp(
    await input.store.saveTaskCaptureResult({
    inboxItemId: input.context.inboxItem.id,
    confidence: input.planning.confidence,
    plannerRun: input.plannerRun,
    tasks: draftTasks,
    scheduleBlocks: scheduleBlocks.blocks,
    followUpMessage: ""
  }),
    input.context.userProfile.timezone
  );
}

async function applyExistingTaskScheduleActions(
  input: ApplyPlanningResultInput,
  createScheduleActions: Extract<PlanningAction, { type: "create_schedule_block" }>[]
) {
  if (!input.calendar) {
    return saveClarification(input, "Please connect Google Calendar before scheduling tasks.");
  }

  if (createScheduleActions.some((action) => action.taskRef.kind !== "existing_task")) {
    return saveClarification(input, "Model returned a created-task schedule action without a create_task action.");
  }

  const referencedTaskAliases = createScheduleActions.map((action) => action.taskRef.alias);

  if (new Set(referencedTaskAliases).size !== referencedTaskAliases.length) {
    return saveClarification(
      input,
      "Model returned multiple schedule actions for the same existing task."
    );
  }

  const existingTaskIds: string[] = [];
  const scheduleBlocks: ScheduleBlock[] = [];
  let existingBlocks = await buildRuntimeScheduleBlocks(input.context, input.calendar);

  for (const action of createScheduleActions) {
    const task = resolveTaskReference(input.planningContext, action.taskRef);

    if (!task) {
      return saveClarification(input, `Could not resolve task alias ${action.taskRef.alias}.`);
    }

    existingTaskIds.push(task.id);

    const proposal = await buildScheduleProposal({
      userId: input.context.inboxItem.userId,
      openTasks: [task],
      userProfile: input.context.userProfile,
      existingBlocks,
      scheduleConstraint: action.scheduleConstraint
    });
    const [scheduledBlock] = proposal.inserts;

    if (!scheduledBlock) {
      return saveClarification(input, `Could not build a schedule block for task alias ${action.taskRef.alias}.`);
    }

    const persistedSchedule = await scheduleTaskWithCalendar({
      calendar: input.calendar,
      task,
      selectedCalendarId: input.context.googleCalendarConnection?.selectedCalendarId ?? null,
      proposedBlock: {
        ...scheduledBlock,
        externalCalendarId:
          input.context.googleCalendarConnection?.selectedCalendarId ?? scheduledBlock.externalCalendarId,
        reason: action.reason
      }
    });

    scheduleBlocks.push(persistedSchedule);
    existingBlocks = [...existingBlocks, persistedSchedule];
  }

  return withRenderedFollowUp(
    await input.store.saveScheduleRequestResult({
    inboxItemId: input.context.inboxItem.id,
    confidence: input.planning.confidence,
    plannerRun: input.plannerRun,
    taskIds: existingTaskIds,
    scheduleBlocks,
    followUpMessage: ""
  }),
    input.context.userProfile.timezone
  );
}

async function applyMoveAction(
  input: ApplyPlanningResultInput,
  action: Extract<PlanningAction, { type: "move_schedule_block" }>
) {
  if (!input.calendar) {
    return saveClarification(input, "Please connect Google Calendar before moving scheduled work.");
  }

  const block = resolveScheduleBlockReference(input.planningContext, action.blockRef);

  if (!block) {
    return saveClarification(input, `Could not resolve schedule block alias ${action.blockRef.alias}.`);
  }

  const existingBlocks = await buildRuntimeScheduleBlocks(input.context, input.calendar);
  const adjustment = buildScheduleAdjustment({
    block,
    userProfile: input.context.userProfile,
    scheduleConstraint: action.scheduleConstraint,
    existingBlocks
  });

  const task = input.context.tasks.find((candidate) => candidate.id === block.taskId);

  if (!task || task.externalCalendarId === null) {
    return saveClarification(input, `Could not resolve current scheduled task for alias ${action.blockRef.alias}.`);
  }

  const liveEvent = await input.calendar.getEvent({
    externalCalendarEventId: block.id,
    externalCalendarId: task.externalCalendarId
  });

  if (!liveEvent) {
    await input.store.reconcileTaskCalendarProjection({
      taskId: task.id,
      externalCalendarEventId: task.externalCalendarEventId,
      externalCalendarId: task.externalCalendarId,
      scheduledStartAt: task.scheduledStartAt,
      scheduledEndAt: task.scheduledEndAt,
      calendarSyncStatus: "out_of_sync",
      calendarSyncUpdatedAt: new Date().toISOString()
    });

    return saveClarification(input, `Could not resolve schedule block alias ${action.blockRef.alias}.`);
  }

  const drift = detectTaskCalendarDrift({
    task,
    liveEvent
  });

  if (drift) {
    await input.store.reconcileTaskCalendarProjection({
      taskId: task.id,
      externalCalendarEventId: task.externalCalendarEventId,
      externalCalendarId: task.externalCalendarId,
      scheduledStartAt: task.scheduledStartAt,
      scheduledEndAt: task.scheduledEndAt,
      calendarSyncStatus: "out_of_sync",
      calendarSyncUpdatedAt: new Date().toISOString()
    });

    return saveClarification(
      input,
      "The linked Google Calendar event changed outside Atlas. Please confirm the current slot or choose a new time."
    );
  }

  const updatedEvent = await input.calendar.updateEvent({
    externalCalendarEventId: liveEvent.externalCalendarEventId,
    externalCalendarId: liveEvent.externalCalendarId,
    title: task.title,
    startAt: adjustment.newStartAt,
    endAt: adjustment.newEndAt
  });

  return withRenderedFollowUp(
    await input.store.saveScheduleAdjustmentResult({
    inboxItemId: input.context.inboxItem.id,
    confidence: input.planning.confidence,
    plannerRun: input.plannerRun,
    blockId: updatedEvent.externalCalendarEventId,
    newStartAt: updatedEvent.scheduledStartAt,
    newEndAt: updatedEvent.scheduledEndAt,
    reason: action.reason,
    followUpMessage: ""
  }),
    input.context.userProfile.timezone
  );
}

async function buildScheduleBlocksForCreatedTasks(
  context: ApplyPlanningResultInput["context"],
  createScheduleActions: Extract<PlanningAction, { type: "create_schedule_block" }>[],
  createdTaskAliases: Map<string, Task>,
  calendar: ExternalCalendarAdapter
) {
  const blocks: ScheduleBlock[] = [];
  let existingBlocks = await buildRuntimeScheduleBlocks(context, calendar);

  for (const action of createScheduleActions) {
    if (action.taskRef.kind !== "created_task") {
      return {
        reason: "Expected created-task references while building new task schedule blocks."
      };
    }

    const task = createdTaskAliases.get(action.taskRef.alias);

    if (!task) {
      return {
        reason: `Could not resolve created task alias ${action.taskRef.alias}.`
      };
    }

    const proposal = await buildScheduleProposal({
      userId: context.inboxItem.userId,
      openTasks: [task],
      userProfile: context.userProfile,
      existingBlocks,
      scheduleConstraint: action.scheduleConstraint
    });
    const [scheduledBlock] = proposal.inserts;

    if (!scheduledBlock) {
      return {
        reason: `Could not build a schedule block for created task alias ${action.taskRef.alias}.`
      };
    }

    const persistedSchedule = await scheduleTaskWithCalendar({
      calendar,
      task,
      selectedCalendarId: context.googleCalendarConnection?.selectedCalendarId ?? null,
      proposedBlock: {
        ...scheduledBlock,
        taskId: action.taskRef.alias,
        externalCalendarId:
          context.googleCalendarConnection?.selectedCalendarId ?? scheduledBlock.externalCalendarId,
        reason: action.reason
      }
    });

    blocks.push(persistedSchedule);
    existingBlocks = [...existingBlocks, persistedSchedule];
  }

  return {
    blocks
  };
}

async function scheduleTaskWithCalendar(input: {
  calendar: ExternalCalendarAdapter;
  task: Task;
  selectedCalendarId: string | null;
  proposedBlock: ScheduleBlock;
}): Promise<ScheduleBlock> {
  const currentEvent = await getCurrentCalendarEvent(input.calendar, input.task);
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
    endAt: input.proposedBlock.endAt
  });

  try {
    const calendarEvent = currentEvent
      ? await input.calendar.updateEvent({
          externalCalendarEventId: currentEvent.externalCalendarEventId,
          externalCalendarId: currentEvent.externalCalendarId,
          title: input.task.title,
          startAt: input.proposedBlock.startAt,
          endAt: input.proposedBlock.endAt
        })
      : await input.calendar.createEvent({
          title: input.task.title,
          startAt: input.proposedBlock.startAt,
          endAt: input.proposedBlock.endAt,
          externalCalendarId
        });

    logCalendarWriteSuccess({
      operation,
      taskId: input.task.id,
      userId: input.task.userId,
      externalCalendarEventId: calendarEvent.externalCalendarEventId,
      externalCalendarId: calendarEvent.externalCalendarId,
      startAt: calendarEvent.scheduledStartAt,
      endAt: calendarEvent.scheduledEndAt
    });

    return buildScheduleBlockFromCalendarEvent({
      taskId: input.proposedBlock.taskId,
      userId: input.task.userId,
      reason: input.proposedBlock.reason,
      rescheduleCount: input.proposedBlock.rescheduleCount,
      confidence: input.proposedBlock.confidence,
      calendarEvent
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
      error
    });
    throw error;
  }
}

async function buildRuntimeScheduleBlocks(
  context: ApplyPlanningResultInput["context"],
  calendar: ExternalCalendarAdapter
) {
  const existingBlocks = [...context.scheduleBlocks];

  if (!context.googleCalendarConnection) {
    return existingBlocks;
  }

  const busyPeriods = await calendar.listBusyPeriods({
    startAt: new Date().toISOString(),
    endAt: new Date(Date.now() + CALENDAR_BUSY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    externalCalendarId: context.googleCalendarConnection.selectedCalendarId
  });

  return [
    ...existingBlocks,
    ...buildBusyScheduleBlocks({
      userId: context.inboxItem.userId,
      periods: filterBusyPeriodsAgainstAtlasTasks(context.tasks, busyPeriods)
    })
  ];
}

function filterBusyPeriodsAgainstAtlasTasks(tasks: Task[], busyPeriods: CalendarBusyPeriod[]) {
  return busyPeriods.filter(
    (period) =>
      !tasks.some(
        (task) =>
          task.externalCalendarId === period.externalCalendarId &&
          task.scheduledStartAt === period.startAt &&
          task.scheduledEndAt === period.endAt
      )
  );
}

async function getCurrentCalendarEvent(calendar: ExternalCalendarAdapter, task: Task) {
  if (task.externalCalendarEventId === null || task.externalCalendarId === null) {
    return null;
  }

  return calendar.getEvent({
    externalCalendarEventId: task.externalCalendarEventId,
    externalCalendarId: task.externalCalendarId
  });
}

function buildScheduleBlockFromCalendarEvent(input: {
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
    externalCalendarId: input.calendarEvent.externalCalendarId
  };
}

function logCalendarWriteAttempt(input: {
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

function logCalendarWriteSuccess(input: {
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

function logCalendarWriteFailure(input: {
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
        ? {
            name: input.error.name,
            message: input.error.message
          }
        : {
            message: String(input.error)
          }
  });
}

function saveClarification(input: ApplyPlanningResultInput, reason: string) {
  return input.store.saveNeedsClarificationResult({
    inboxItemId: input.context.inboxItem.id,
    confidence: input.planning.confidence,
    plannerRun: input.plannerRun,
    reason,
    followUpMessage: reason
  }).then((result) => withRenderedFollowUp(result, input.context.userProfile.timezone));
}

function buildPlannerRun(
  context: ApplyPlanningResultInput["context"],
  planningContext: InboxPlanningContext,
  modelOutput: unknown
) {
  return {
    userId: context.inboxItem.userId,
    inboxItemId: context.inboxItem.id,
    version: "process-inbox-item-responses-v1",
    modelInput: planningContext,
    modelOutput,
    confidence:
      typeof modelOutput === "object" &&
      modelOutput !== null &&
      "confidence" in modelOutput &&
      typeof modelOutput.confidence === "number"
        ? modelOutput.confidence
        : 0
  };
}

function buildErrorEnvelope(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: "UnknownError",
    message: "Unknown inbox planner failure."
  };
}

function parseProcessInboxItemRequest(input: ProcessInboxItemRequest): ProcessInboxItemRequest {
  if (typeof input.inboxItemId !== "string" || input.inboxItemId.length === 0) {
    throw new Error("processInboxItem requires an inboxItemId.");
  }

  if (
    input.planningInboxTextOverride &&
    !input.planningInboxTextOverride.text.trim()
  ) {
    throw new Error("planningInboxTextOverride must include non-empty text.");
  }

  return input;
}

function withRenderedFollowUp(result: ProcessedInboxResult, timeZone: string): ProcessedInboxResult {
  return {
    ...result,
    followUpMessage: renderMutationReply(result, { timeZone })
  };
}
