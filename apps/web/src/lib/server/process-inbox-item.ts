import {
  buildCapturedTask,
  buildInboxPlanningContext,
  buildScheduleAdjustment,
  buildScheduleProposal,
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
  getDefaultCalendarAdapter,
  planInboxItemWithResponses,
  type CalendarEventSnapshot,
  type ExternalCalendarAdapter
} from "@atlas/integrations";

export type ProcessInboxItemRequest = {
  inboxItemId: string;
  planningInboxTextOverride?: {
    rawText: string;
    normalizedText: string;
  };
};

export type ProcessInboxItemDependencies = {
  store?: InboxProcessingStore;
  planner?: typeof planInboxItemWithResponses;
  calendar?: ExternalCalendarAdapter;
};

export async function processInboxItem(
  input: ProcessInboxItemRequest,
  dependencies: ProcessInboxItemDependencies = {}
): Promise<ProcessedInboxResult> {
  const parsed = parseProcessInboxItemRequest(input);
  const store = dependencies.store ?? getDefaultInboxProcessingStore();
  const planner = dependencies.planner ?? planInboxItemWithResponses;
  const calendar = dependencies.calendar ?? getDefaultCalendarAdapter();
  const context = await store.loadContext(parsed.inboxItemId);

  if (!context) {
    throw new Error(`Inbox item ${parsed.inboxItemId} not found.`);
  }

  await store.markInboxProcessing(parsed.inboxItemId);

  const planningContext = buildInboxPlanningContext({
    inboxItem: input.planningInboxTextOverride
      ? {
          ...context.inboxItem,
          rawText: input.planningInboxTextOverride.rawText,
          normalizedText: input.planningInboxTextOverride.normalizedText
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
  calendar: ExternalCalendarAdapter;
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

    return input.store.saveNeedsClarificationResult({
      inboxItemId: input.context.inboxItem.id,
      confidence: input.planning.confidence,
      plannerRun: input.plannerRun,
      reason: clarifyAction.reason,
      followUpMessage: input.planning.userReplyMessage
    });
  }

  if (moveActions.length > 0) {
    if (moveActions.length !== 1 || createTaskActions.length > 0 || createScheduleActions.length > 0) {
      return saveClarification(input, "Model returned an unsupported mix of move and create actions.");
    }

    const moveAction = moveActions[0];

    if (!moveAction) {
      return saveClarification(input, "Model did not provide a valid move action.");
    }

    return applyMoveAction(input, moveAction);
  }

  if (createTaskActions.length > 0) {
    return applyCreatedTaskActions(input, createTaskActions, createScheduleActions);
  }

  if (createScheduleActions.length > 0) {
    return applyExistingTaskScheduleActions(input, createScheduleActions);
  }

  return saveClarification(input, "Model returned no actionable planning actions.");
}

async function applyCreatedTaskActions(
  input: ApplyPlanningResultInput,
  createTaskActions: Extract<PlanningAction, { type: "create_task" }>[],
  createScheduleActions: Extract<PlanningAction, { type: "create_schedule_block" }>[]
) {
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

  return input.store.saveTaskCaptureResult({
    inboxItemId: input.context.inboxItem.id,
    confidence: input.planning.confidence,
    plannerRun: input.plannerRun,
    tasks: draftTasks,
    scheduleBlocks: scheduleBlocks.blocks,
    followUpMessage: input.planning.userReplyMessage
  });
}

async function applyExistingTaskScheduleActions(
  input: ApplyPlanningResultInput,
  createScheduleActions: Extract<PlanningAction, { type: "create_schedule_block" }>[]
) {
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
  let existingBlocks = [...input.context.scheduleBlocks];

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
      proposedBlock: {
        ...scheduledBlock,
        reason: action.reason
      }
    });

    scheduleBlocks.push(persistedSchedule);
    existingBlocks = [...existingBlocks, persistedSchedule];
  }

  return input.store.saveScheduleRequestResult({
    inboxItemId: input.context.inboxItem.id,
    confidence: input.planning.confidence,
    plannerRun: input.plannerRun,
    taskIds: existingTaskIds,
    scheduleBlocks,
    followUpMessage: input.planning.userReplyMessage
  });
}

async function applyMoveAction(
  input: ApplyPlanningResultInput,
  action: Extract<PlanningAction, { type: "move_schedule_block" }>
) {
  const block = resolveScheduleBlockReference(input.planningContext, action.blockRef);

  if (!block) {
    return saveClarification(input, `Could not resolve schedule block alias ${action.blockRef.alias}.`);
  }

  const adjustment = buildScheduleAdjustment({
    block,
    userProfile: input.context.userProfile,
    scheduleConstraint: action.scheduleConstraint,
    existingBlocks: input.context.scheduleBlocks
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
    return saveClarification(input, `Could not resolve schedule block alias ${action.blockRef.alias}.`);
  }

  const updatedEvent = await input.calendar.updateEvent({
    externalCalendarEventId: liveEvent.externalCalendarEventId,
    externalCalendarId: liveEvent.externalCalendarId,
    title: task.title,
    startAt: adjustment.newStartAt,
    endAt: adjustment.newEndAt
  });

  return input.store.saveScheduleAdjustmentResult({
    inboxItemId: input.context.inboxItem.id,
    confidence: input.planning.confidence,
    plannerRun: input.plannerRun,
    blockId: updatedEvent.externalCalendarEventId,
    newStartAt: updatedEvent.scheduledStartAt,
    newEndAt: updatedEvent.scheduledEndAt,
    reason: action.reason,
    followUpMessage: input.planning.userReplyMessage
  });
}

async function buildScheduleBlocksForCreatedTasks(
  context: ApplyPlanningResultInput["context"],
  createScheduleActions: Extract<PlanningAction, { type: "create_schedule_block" }>[],
  createdTaskAliases: Map<string, Task>,
  calendar: ExternalCalendarAdapter
) {
  const blocks: ScheduleBlock[] = [];
  let existingBlocks = [...context.scheduleBlocks];

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
      proposedBlock: {
        ...scheduledBlock,
        taskId: action.taskRef.alias,
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
  proposedBlock: ScheduleBlock;
}): Promise<ScheduleBlock> {
  const currentEvent = await getCurrentCalendarEvent(input.calendar, input.task);

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
        externalCalendarId: input.task.externalCalendarId
      });

  return buildScheduleBlockFromCalendarEvent({
    taskId: input.proposedBlock.taskId,
    userId: input.task.userId,
    reason: input.proposedBlock.reason,
    rescheduleCount: input.proposedBlock.rescheduleCount,
    confidence: input.proposedBlock.confidence,
    calendarEvent
  });
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

function saveClarification(input: ApplyPlanningResultInput, reason: string) {
  return input.store.saveNeedsClarificationResult({
    inboxItemId: input.context.inboxItem.id,
    confidence: input.planning.confidence,
    plannerRun: input.plannerRun,
    reason,
    followUpMessage: reason
  });
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
    (!input.planningInboxTextOverride.rawText.trim() || !input.planningInboxTextOverride.normalizedText.trim())
  ) {
    throw new Error("planningInboxTextOverride must include non-empty rawText and normalizedText.");
  }

  return input;
}
