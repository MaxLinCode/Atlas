import type { ScheduleBlock, Task } from "@atlas/core";

export function hasAmbiguousTaskTitle(tasks: Task[], task: Task) {
  return findActionableTasksWithSameTitle(tasks, task).length > 1;
}

export function hasAmbiguousScheduledTitle(
  tasks: Task[],
  scheduleBlocks: ScheduleBlock[],
  taskId: string,
) {
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

export function findActionableTasksWithSameTitle(tasks: Task[], task: Task) {
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
) {
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

function normalizeTaskTitle(title: string) {
  return title.trim().toLocaleLowerCase();
}

function isTaskActionable(task: Task) {
  return task.lifecycleState !== "done" && task.lifecycleState !== "archived";
}

export function buildAmbiguousTaskReply(input: {
  tasks: Task[];
  title: string;
  actionPrompt: "update" | "move";
  timeZone: string;
}) {
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

function describeTaskOption(task: Task, timeZone: string) {
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

function formatClarificationTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
