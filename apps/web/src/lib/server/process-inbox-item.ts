import {
  buildCapturedTask,
  buildInboxPlanningContext,
  buildScheduleAdjustment,
  buildScheduleProposal,
  detectTaskCalendarDrift,
  type InboxPlanningContext,
  type InboxPlanningOutput,
  type PlanningAction,
  resolveScheduleBlockReference,
  resolveTaskReference,
  type ScheduleBlock,
  type Task,
} from "@atlas/core";
import {
  type DraftTaskForPersistence,
  getDefaultInboxProcessingStore,
  type InboxProcessingStore,
  type ProcessedInboxResult,
} from "@atlas/db";
import {
  type ExternalCalendarAdapter,
  planInboxItemWithResponses,
} from "@atlas/integrations";
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
import {
  buildAmbiguousTaskReply,
  findActionableTasksWithSameTitle,
  findScheduledTasksWithSameTitle,
  hasAmbiguousScheduledTitle,
  hasAmbiguousTaskTitle,
} from "./ambiguous-title";
import { resolveGoogleCalendarAdapter } from "./google-calendar";
import { renderMutationReply } from "./mutation-reply";

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

export async function processInboxItem(
  input: ProcessInboxItemRequest,
  dependencies: ProcessInboxItemDependencies = {},
): Promise<ProcessedInboxResult> {
  const parsed = parseProcessInboxItemRequest(input);
  const store = dependencies.store ?? getDefaultInboxProcessingStore();
  const planner = dependencies.planner ?? planInboxItemWithResponses;
  const context = await store.loadContext(parsed.inboxItemId);

  if (!context) {
    throw new Error(`Inbox item ${parsed.inboxItemId} not found.`);
  }

  await store.markInboxProcessing(parsed.inboxItemId);
  const referenceTime = requireInboxReferenceTime(context.inboxItem);

  const planningContext = buildInboxPlanningContext({
    inboxItem: input.planningInboxTextOverride
      ? {
          ...context.inboxItem,
          rawText: input.planningInboxTextOverride.text,
          normalizedText: input.planningInboxTextOverride.text,
        }
      : context.inboxItem,
    userProfile: context.userProfile,
    tasks: context.tasks,
    scheduleBlocks: context.scheduleBlocks,
    referenceTime,
  });

  let planning: InboxPlanningOutput;

  try {
    planning = await planner(planningContext);
  } catch (error) {
    await store.saveFailedPlannerRun({
      inboxItemId: context.inboxItem.id,
      plannerRun: buildPlannerRun(context, planningContext, {
        failure: buildErrorEnvelope(error),
      }),
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
              await resolveGoogleCalendarAdapter(
                context.googleCalendarConnection,
              )
            ).adapter
          : null;

    return await applyPlanningResult({
      context,
      planningContext,
      planning,
      plannerRun,
      store,
      calendar,
    });
  } catch (error) {
    await store.saveFailedPlannerRun({
      inboxItemId: context.inboxItem.id,
      plannerRun: buildPlannerRun(context, planningContext, {
        ...planning,
        failure: buildErrorEnvelope(error),
      }),
    });
    throw error;
  }
}

type ApplyPlanningResultInput = {
  context: Awaited<
    ReturnType<InboxProcessingStore["loadContext"]>
  > extends infer T
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

async function applyPlanningResult(
  input: ApplyPlanningResultInput,
): Promise<ProcessedInboxResult> {
  const actions = input.planning.actions;
  const clarifyAction = actions.find((action) => action.type === "clarify");
  const createTaskActions = actions.filter(
    (action) => action.type === "create_task",
  );
  const createScheduleActions = actions.filter(
    (action) => action.type === "create_schedule_block",
  );
  const moveActions = actions.filter(
    (action) => action.type === "move_schedule_block",
  );
  const completeActions = actions.filter(
    (action) => action.type === "complete_task",
  );

  if (clarifyAction) {
    if (actions.length > 1) {
      return saveClarification(
        input,
        "Model returned clarify alongside mutating actions.",
      );
    }

    return withRenderedFollowUp(
      await input.store.saveNeedsClarificationResult({
        inboxItemId: input.context.inboxItem.id,
        confidence: input.planning.confidence,
        plannerRun: input.plannerRun,
        reason: clarifyAction.reason,
        followUpMessage: buildClarificationReply(clarifyAction.reason),
      }),
      input.context.userProfile.timezone,
    );
  }

  if (moveActions.length > 0) {
    if (
      moveActions.length !== 1 ||
      createTaskActions.length > 0 ||
      createScheduleActions.length > 0 ||
      completeActions.length > 0
    ) {
      return saveClarification(
        input,
        "Model returned an unsupported mix of move and create actions.",
      );
    }

    if (!input.calendar) {
      return saveClarification(
        input,
        "Please connect Google Calendar before moving scheduled work.",
      );
    }

    const moveAction = moveActions[0];

    if (!moveAction) {
      return saveClarification(
        input,
        "Model did not provide a valid move action.",
      );
    }

    return applyMoveAction(input, moveAction);
  }

  if (createTaskActions.length > 0) {
    if (completeActions.length > 0) {
      return saveClarification(
        input,
        "Model returned an unsupported mix of completion and creation actions.",
      );
    }

    if (!input.calendar) {
      return saveClarification(
        input,
        "Please connect Google Calendar before scheduling tasks.",
      );
    }

    return applyCreatedTaskActions(
      input,
      createTaskActions,
      createScheduleActions,
    );
  }

  if (completeActions.length > 0) {
    if (createScheduleActions.length > 0) {
      return saveClarification(
        input,
        "Model returned an unsupported mix of completion and scheduling actions.",
      );
    }

    return applyCompletionActions(input, completeActions);
  }

  if (createScheduleActions.length > 0) {
    if (!input.calendar) {
      return saveClarification(
        input,
        "Please connect Google Calendar before scheduling tasks.",
      );
    }

    return applyExistingTaskScheduleActions(input, createScheduleActions);
  }

  return saveClarification(
    input,
    "Model returned no actionable planning actions.",
  );
}

async function applyCreatedTaskActions(
  input: ApplyPlanningResultInput,
  createTaskActions: Extract<PlanningAction, { type: "create_task" }>[],
  createScheduleActions: Extract<
    PlanningAction,
    { type: "create_schedule_block" }
  >[],
) {
  if (!input.calendar) {
    return saveClarification(
      input,
      "Please connect Google Calendar before scheduling tasks.",
    );
  }

  const createdTaskAliases = new Set(
    createTaskActions.map((action) => action.alias),
  );
  const scheduleActionsForCreatedTasks = createScheduleActions.filter(
    (action) => action.taskRef.kind === "created_task",
  );
  const invalidCreatedTaskReferences = scheduleActionsForCreatedTasks.some(
    (action) => !createdTaskAliases.has(action.taskRef.alias),
  );
  const hasExistingTaskReferences = createScheduleActions.some(
    (action) => action.taskRef.kind === "existing_task",
  );

  if (invalidCreatedTaskReferences || hasExistingTaskReferences) {
    return saveClarification(
      input,
      "Model returned invalid or mixed schedule references for newly created tasks.",
    );
  }

  if (scheduleActionsForCreatedTasks.length !== createTaskActions.length) {
    return saveClarification(
      input,
      "Each created task must have exactly one schedule action in schedule-forward mode.",
    );
  }

  const draftTasks: DraftTaskForPersistence[] = createTaskActions.map(
    (action) => ({
      alias: action.alias,
      task: buildCapturedTask({
        userId: input.context.inboxItem.userId,
        inboxItemId: input.context.inboxItem.id,
        title: action.title,
        priority: action.priority,
        urgency: action.urgency,
      }),
    }),
  );
  const taskAliasToDraftTask = new Map<string, Task>(
    draftTasks.map(({ alias, task }) => [
      alias,
      {
        id: alias,
        ...task,
      },
    ]),
  );
  const scheduleBlocks = await buildScheduleBlocksForCreatedTasks(
    input.context,
    scheduleActionsForCreatedTasks,
    taskAliasToDraftTask,
    input.calendar,
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
      followUpMessage: "",
    }),
    input.context.userProfile.timezone,
  );
}

async function applyExistingTaskScheduleActions(
  input: ApplyPlanningResultInput,
  createScheduleActions: Extract<
    PlanningAction,
    { type: "create_schedule_block" }
  >[],
) {
  if (!input.calendar) {
    return saveClarification(
      input,
      "Please connect Google Calendar before scheduling tasks.",
    );
  }

  if (
    createScheduleActions.some(
      (action) => action.taskRef.kind !== "existing_task",
    )
  ) {
    return saveClarification(
      input,
      "Model returned a created-task schedule action without a create_task action.",
    );
  }

  const referencedTaskAliases = createScheduleActions.map(
    (action) => action.taskRef.alias,
  );

  if (new Set(referencedTaskAliases).size !== referencedTaskAliases.length) {
    return saveClarification(
      input,
      "Model returned multiple schedule actions for the same existing task.",
    );
  }

  const existingTaskIds: string[] = [];
  const scheduleBlocks: ScheduleBlock[] = [];
  let existingBlocks = await buildRuntimeScheduleBlocks({
    scheduleBlocks: input.context.scheduleBlocks,
    tasks: input.context.tasks,
    userId: input.context.inboxItem.userId,
    googleCalendarConnection: input.context.googleCalendarConnection,
    calendar: input.calendar!,
    referenceTime: input.planningContext.referenceTime,
  });

  for (const action of createScheduleActions) {
    const task = resolveTaskReference(input.planningContext, action.taskRef);

    if (!task) {
      return saveClarification(
        input,
        `Could not resolve task alias ${action.taskRef.alias}.`,
      );
    }

    if (hasAmbiguousTaskTitle(input.context.tasks, task)) {
      return saveClarification(
        input,
        buildAmbiguousTaskReply({
          tasks: findActionableTasksWithSameTitle(input.context.tasks, task),
          title: task.title,
          actionPrompt: "update",
          timeZone: input.context.userProfile.timezone,
        }),
      );
    }

    existingTaskIds.push(task.id);

    const proposal = await buildScheduleProposal({
      userId: input.context.inboxItem.userId,
      openTasks: [task],
      userProfile: input.context.userProfile,
      existingBlocks,
      scheduleConstraint: action.scheduleConstraint,
      referenceTime: input.planningContext.referenceTime,
    });
    const [scheduledBlock] = proposal.inserts;

    if (!scheduledBlock) {
      return saveClarification(
        input,
        `Could not build a schedule block for task alias ${action.taskRef.alias}.`,
      );
    }

    const persistedSchedule = await scheduleTaskWithCalendar({
      calendar: input.calendar,
      task,
      selectedCalendarId:
        input.context.googleCalendarConnection?.selectedCalendarId ?? null,
      proposedBlock: {
        ...scheduledBlock,
        externalCalendarId:
          input.context.googleCalendarConnection?.selectedCalendarId ??
          scheduledBlock.externalCalendarId,
        reason: action.reason,
      },
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
      followUpMessage: "",
    }),
    input.context.userProfile.timezone,
  );
}

async function applyMoveAction(
  input: ApplyPlanningResultInput,
  action: Extract<PlanningAction, { type: "move_schedule_block" }>,
) {
  if (!input.calendar) {
    return saveClarification(
      input,
      "Please connect Google Calendar before moving scheduled work.",
    );
  }

  const block = resolveScheduleBlockReference(
    input.planningContext,
    action.blockRef,
  );

  if (!block) {
    return saveClarification(
      input,
      `Could not resolve schedule block alias ${action.blockRef.alias}.`,
    );
  }

  const existingBlocks = await buildRuntimeScheduleBlocks({
    scheduleBlocks: input.context.scheduleBlocks,
    tasks: input.context.tasks,
    userId: input.context.inboxItem.userId,
    googleCalendarConnection: input.context.googleCalendarConnection,
    calendar: input.calendar!,
    referenceTime: input.planningContext.referenceTime,
  });
  const adjustment = buildScheduleAdjustment({
    block,
    userProfile: input.context.userProfile,
    scheduleConstraint: action.scheduleConstraint,
    existingBlocks,
    referenceTime: input.planningContext.referenceTime,
  });

  const task = input.context.tasks.find(
    (candidate) => candidate.id === block.taskId,
  );

  if (!task || task.externalCalendarId === null) {
    return saveClarification(
      input,
      `Could not resolve current scheduled task for alias ${action.blockRef.alias}.`,
    );
  }

  if (
    hasAmbiguousScheduledTitle(
      input.context.tasks,
      input.context.scheduleBlocks,
      block.taskId,
    )
  ) {
    return saveClarification(
      input,
      buildAmbiguousTaskReply({
        tasks: findScheduledTasksWithSameTitle(
          input.context.tasks,
          input.context.scheduleBlocks,
          block.taskId,
        ),
        title: task.title,
        actionPrompt: "move",
        timeZone: input.context.userProfile.timezone,
      }),
    );
  }

  const liveEvent = await input.calendar.getEvent({
    externalCalendarEventId: block.id,
    externalCalendarId: task.externalCalendarId,
  });

  if (!liveEvent) {
    await input.store.reconcileTaskCalendarProjection({
      taskId: task.id,
      externalCalendarEventId: task.externalCalendarEventId,
      externalCalendarId: task.externalCalendarId,
      scheduledStartAt: task.scheduledStartAt,
      scheduledEndAt: task.scheduledEndAt,
      calendarSyncStatus: "out_of_sync",
      calendarSyncUpdatedAt: new Date().toISOString(),
    });

    return saveClarification(
      input,
      `Could not resolve schedule block alias ${action.blockRef.alias}.`,
    );
  }

  const drift = detectTaskCalendarDrift({
    task,
    liveEvent,
  });

  if (drift) {
    await input.store.reconcileTaskCalendarProjection({
      taskId: task.id,
      externalCalendarEventId: task.externalCalendarEventId,
      externalCalendarId: task.externalCalendarId,
      scheduledStartAt: task.scheduledStartAt,
      scheduledEndAt: task.scheduledEndAt,
      calendarSyncStatus: "out_of_sync",
      calendarSyncUpdatedAt: new Date().toISOString(),
    });

    return saveClarification(
      input,
      "The linked Google Calendar event changed outside Atlas. Please confirm the current slot or choose a new time.",
    );
  }

  const updatedEvent = await input.calendar.updateEvent({
    externalCalendarEventId: liveEvent.externalCalendarEventId,
    externalCalendarId: liveEvent.externalCalendarId,
    title: task.title,
    startAt: adjustment.newStartAt,
    endAt: adjustment.newEndAt,
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
      followUpMessage: "",
    }),
    input.context.userProfile.timezone,
  );
}

async function applyCompletionActions(
  input: ApplyPlanningResultInput,
  completeActions: Extract<PlanningAction, { type: "complete_task" }>[],
) {
  const referencedTaskAliases = completeActions.map(
    (action) => action.taskRef.alias,
  );

  if (new Set(referencedTaskAliases).size !== referencedTaskAliases.length) {
    return saveClarification(
      input,
      "Model returned multiple completion actions for the same task.",
    );
  }

  const taskIds: string[] = [];

  for (const action of completeActions) {
    if (action.taskRef.kind !== "existing_task") {
      return saveClarification(
        input,
        "Model returned a completion action for a non-persisted task.",
      );
    }

    const task = resolveTaskReference(input.planningContext, action.taskRef);

    if (!task) {
      return saveClarification(
        input,
        `Could not resolve task alias ${action.taskRef.alias}.`,
      );
    }

    if (hasAmbiguousTaskTitle(input.context.tasks, task)) {
      return saveClarification(
        input,
        buildAmbiguousTaskReply({
          tasks: findActionableTasksWithSameTitle(input.context.tasks, task),
          title: task.title,
          actionPrompt: "update",
          timeZone: input.context.userProfile.timezone,
        }),
      );
    }

    taskIds.push(task.id);
  }

  return withRenderedFollowUp(
    await input.store.saveTaskCompletionResult({
      inboxItemId: input.context.inboxItem.id,
      confidence: input.planning.confidence,
      plannerRun: input.plannerRun,
      taskIds,
      followUpMessage: "",
    }),
    input.context.userProfile.timezone,
  );
}

async function buildScheduleBlocksForCreatedTasks(
  context: ApplyPlanningResultInput["context"],
  createScheduleActions: Extract<
    PlanningAction,
    { type: "create_schedule_block" }
  >[],
  createdTaskAliases: Map<string, Task>,
  calendar: ExternalCalendarAdapter,
) {
  const blocks: ScheduleBlock[] = [];
  let existingBlocks = await buildRuntimeScheduleBlocks({
    scheduleBlocks: context.scheduleBlocks,
    tasks: context.tasks,
    userId: context.inboxItem.userId,
    googleCalendarConnection: context.googleCalendarConnection,
    calendar,
    referenceTime: requireInboxReferenceTime(context.inboxItem),
  });

  for (const action of createScheduleActions) {
    if (action.taskRef.kind !== "created_task") {
      return {
        reason:
          "Expected created-task references while building new task schedule blocks.",
      };
    }

    const task = createdTaskAliases.get(action.taskRef.alias);

    if (!task) {
      return {
        reason: `Could not resolve created task alias ${action.taskRef.alias}.`,
      };
    }

    const proposal = await buildScheduleProposal({
      userId: context.inboxItem.userId,
      openTasks: [task],
      userProfile: context.userProfile,
      existingBlocks,
      scheduleConstraint: action.scheduleConstraint,
      referenceTime: requireInboxReferenceTime(context.inboxItem),
    });
    const [scheduledBlock] = proposal.inserts;

    if (!scheduledBlock) {
      return {
        reason: `Could not build a schedule block for created task alias ${action.taskRef.alias}.`,
      };
    }

    const persistedSchedule = await scheduleTaskWithCalendar({
      calendar,
      task,
      selectedCalendarId:
        context.googleCalendarConnection?.selectedCalendarId ?? null,
      proposedBlock: {
        ...scheduledBlock,
        taskId: action.taskRef.alias,
        externalCalendarId:
          context.googleCalendarConnection?.selectedCalendarId ??
          scheduledBlock.externalCalendarId,
        reason: action.reason,
      },
    });

    blocks.push(persistedSchedule);
    existingBlocks = [...existingBlocks, persistedSchedule];
  }

  return {
    blocks,
  };
}

function saveClarification(input: ApplyPlanningResultInput, reason: string) {
  return input.store
    .saveNeedsClarificationResult({
      inboxItemId: input.context.inboxItem.id,
      confidence: input.planning.confidence,
      plannerRun: input.plannerRun,
      reason,
      followUpMessage: buildClarificationReply(reason),
    })
    .then((result) =>
      withRenderedFollowUp(result, input.context.userProfile.timezone),
    );
}

function buildClarificationReply(reason: string) {
  if (!isSafeUserFacingClarificationReason(reason)) {
    return "I couldn't safely apply that update. Tell me the exact task and what you'd like me to change.";
  }

  return reason;
}

function isSafeUserFacingClarificationReason(reason: string) {
  if (
    reason.startsWith("Model returned") ||
    reason.startsWith("Could not resolve") ||
    reason.startsWith("Expected ") ||
    reason.startsWith("Each created task must") ||
    reason.startsWith("Model did not provide") ||
    reason.startsWith("Please connect Google Calendar before") ||
    reason.startsWith(
      "The linked Google Calendar event changed outside Atlas.",
    ) ||
    reason.startsWith("I couldn't safely apply that update.")
  ) {
    return (
      reason.startsWith("Please connect Google Calendar before") ||
      reason.startsWith(
        "The linked Google Calendar event changed outside Atlas.",
      ) ||
      reason.startsWith("I couldn't safely apply that update.")
    );
  }

  return true;
}

function requireInboxReferenceTime(
  inboxItem: ApplyPlanningResultInput["context"]["inboxItem"],
) {
  if (!inboxItem.createdAt) {
    throw new Error(
      `Inbox item ${inboxItem.id} is missing createdAt for scheduling reference time.`,
    );
  }

  return inboxItem.createdAt;
}

function buildPlannerRun(
  context: ApplyPlanningResultInput["context"],
  planningContext: InboxPlanningContext,
  modelOutput: unknown,
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
        : 0,
  };
}

function buildErrorEnvelope(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "UnknownError",
    message: "Unknown inbox planner failure.",
  };
}

function parseProcessInboxItemRequest(
  input: ProcessInboxItemRequest,
): ProcessInboxItemRequest {
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

function withRenderedFollowUp(
  result: ProcessedInboxResult,
  timeZone: string,
): ProcessedInboxResult {
  return {
    ...result,
    followUpMessage: renderMutationReply(result, { timeZone }),
  };
}
