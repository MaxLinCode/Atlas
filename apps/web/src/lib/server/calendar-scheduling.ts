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

export const CALENDAR_BUSY_LOOKAHEAD_DAYS = 14;

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
) {
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
) {
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
        ? {
            name: input.error.name,
            message: input.error.message,
          }
        : {
            message: String(input.error),
          },
  });
}
