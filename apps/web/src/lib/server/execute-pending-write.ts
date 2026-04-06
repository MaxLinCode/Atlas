import {
  buildCapturedTask,
  buildScheduleAdjustment,
  buildScheduleProposal,
  detectTaskCalendarDrift,
  type MutationResult,
  type PendingWriteOperation,
  type ScheduleBlock,
  type ScheduleConstraint,
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
  buildAmbiguousTaskReply,
  hasAmbiguousScheduledTitle,
  hasAmbiguousTaskTitle,
} from "./ambiguous-title";

export type ExecutePendingWriteInput = {
  pendingWriteOperation: PendingWriteOperation;
  userId: string;
  tasks: Task[];
  scheduleBlocks: ScheduleBlock[];
  userProfile: UserProfile;
  calendar: ExternalCalendarAdapter | null;
  googleCalendarConnection: GoogleCalendarConnection | null;
  store: Pick<
    InboxProcessingStore,
    | "saveTaskCaptureResult"
    | "saveScheduleRequestResult"
    | "saveScheduleAdjustmentResult"
    | "saveTaskCompletionResult"
    | "saveTaskArchiveResult"
    | "saveNeedsClarificationResult"
  >;
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
        followUpMessage:
          "I can't edit tasks directly yet. Try telling me what you'd like to change.",
      };
    default: {
      const _exhaustive: never = op.operationKind;
      return {
        outcome: "needs_clarification",
        reason: `Unknown operation kind: ${String(_exhaustive)}`,
        followUpMessage: "I'm not sure what to do with that request.",
      };
    }
  }
}

export function buildScheduleConstraintFromFields(
  scheduleFields: PendingWriteOperation["resolvedFields"]["scheduleFields"],
  sourceText: string,
): ScheduleConstraint | null {
  if (!scheduleFields) return null;
  if (!scheduleFields.time && !scheduleFields.day) return null;

  // relative time: "in 30 minutes" — cannot combine with other timing fields
  if (scheduleFields.time?.kind === "relative") {
    return {
      dayReference: null,
      weekday: null,
      weekOffset: null,
      relativeMinutes: scheduleFields.time.minutes,
      explicitHour: null,
      minute: null,
      preferredWindow: null,
      sourceText,
    };
  }

  const time =
    scheduleFields.time?.kind === "absolute" ? scheduleFields.time : null;

  return {
    dayReference: null,
    weekday: null,
    weekOffset: null,
    relativeMinutes: null,
    explicitHour: time?.hour ?? null,
    minute: time?.minute ?? null,
    preferredWindow:
      scheduleFields.time?.kind === "window"
        ? scheduleFields.time.window
        : null,
    sourceText,
  };
}

async function executeCreateNew(
  input: ExecutePendingWriteInput,
): Promise<MutationResult> {
  const { pendingWriteOperation: op, userProfile } = input;
  const title = op.targetRef?.description ?? op.originatingText;

  const taskFields = op.resolvedFields.taskFields;
  const priority =
    taskFields?.priority === "low" ||
    taskFields?.priority === "medium" ||
    taskFields?.priority === "high"
      ? taskFields.priority
      : ("medium" as const);
  const urgency =
    taskFields?.urgency === "low" ||
    taskFields?.urgency === "medium" ||
    taskFields?.urgency === "high"
      ? taskFields.urgency
      : ("medium" as const);

  const task = buildCapturedTask({
    userId: input.userId,
    inboxItemId: `exec:${op.startedAt}`,
    title,
    priority,
    urgency,
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

    const scheduleConstraint = buildScheduleConstraintFromFields(
      op.resolvedFields.scheduleFields,
      op.originatingText,
    );

    const draftTask = { ...task, id: "draft" } as Task;

    const proposal = await buildScheduleProposal({
      userId: input.userId,
      openTasks: [draftTask],
      userProfile,
      scheduleConstraint,
      existingBlocks: runtimeBlocks,
      referenceTime: op.startedAt,
    });

    const [proposedBlock] = proposal.inserts;
    if (proposedBlock) {
      const scheduled = await scheduleTaskWithCalendar({
        calendar: input.calendar,
        task: draftTask,
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
  const targetTask = input.tasks.find((t) => t.id === op.targetRef?.entityId);

  if (!targetTask) {
    return {
      outcome: "needs_clarification",
      reason: `Could not find task with ID ${op.targetRef?.entityId}`,
      followUpMessage:
        "I couldn't find that task. Could you clarify which one you mean?",
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
      followUpMessage:
        "Please connect Google Calendar before scheduling tasks.",
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

  const scheduleConstraint = buildScheduleConstraintFromFields(
    op.resolvedFields.scheduleFields,
    op.originatingText,
  );

  const proposal = await buildScheduleProposal({
    userId: input.userId,
    openTasks: [targetTask],
    userProfile,
    scheduleConstraint,
    existingBlocks: runtimeBlocks,
    referenceTime: op.startedAt,
  });

  const [proposedBlock] = proposal.inserts;
  if (!proposedBlock) {
    return {
      outcome: "needs_clarification",
      reason: "Could not build a schedule proposal for this task.",
      followUpMessage:
        "I couldn't find a good time slot. Try specifying a different time.",
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

  if (
    hasAmbiguousScheduledTitle(
      input.tasks,
      input.scheduleBlocks,
      targetTaskId,
    )
  ) {
    const targetTask = input.tasks.find((t) => t.id === targetTaskId);
    return {
      outcome: "needs_clarification",
      reason: "Ambiguous scheduled title",
      followUpMessage: buildAmbiguousTaskReply({
        tasks: input.tasks.filter((t) => t.title === targetTask?.title),
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
      followUpMessage:
        "Please connect Google Calendar before rescheduling.",
    };
  }

  const targetTask = input.tasks.find((t) => t.id === targetTaskId);
  if (targetTask) {
    const liveEvent =
      targetTask.externalCalendarEventId && targetTask.externalCalendarId
        ? await input.calendar.getEvent({
            externalCalendarEventId: targetTask.externalCalendarEventId,
            externalCalendarId: targetTask.externalCalendarId,
          })
        : null;

    const drift = detectTaskCalendarDrift({ task: targetTask, liveEvent });
    if (drift !== null) {
      return {
        outcome: "needs_clarification",
        reason: "Calendar drift detected",
        followUpMessage:
          "The linked Google Calendar event changed outside Atlas. Please check the event and try again.",
      };
    }
  }

  const scheduleConstraint = buildScheduleConstraintFromFields(
    op.resolvedFields.scheduleFields,
    op.originatingText,
  );

  const adjustment = buildScheduleAdjustment({
    block: existingBlock,
    userProfile,
    scheduleConstraint,
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
      followUpMessage:
        "I couldn't find that task. Could you clarify which one you mean?",
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
      followUpMessage:
        "I couldn't find that task. Could you clarify which one you mean?",
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
