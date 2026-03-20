import type { ProcessedInboxResult } from "@atlas/db";

const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export function renderMutationReply(
  result: ProcessedInboxResult,
  options: { timeZone?: string } = {}
): string {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;

  switch (result.outcome) {
    case "planned": {
      return renderScheduledItemsReply({
        fallback: "I saved it.",
        tasks: result.createdTasks,
        scheduleBlocks: result.scheduleBlocks,
        timeZone
      });
    }

    case "scheduled_existing_tasks": {
      return renderScheduledItemsReply({
        fallback: "I scheduled it.",
        tasks: result.scheduledTasks,
        scheduleBlocks: result.scheduleBlocks,
        timeZone
      });
    }

    case "updated_schedule": {
      return `Moved it to ${formatScheduledTime(result.updatedBlock.startAt, timeZone)}.`;
    }

    case "completed_tasks":
      return renderCompletedTasksReply(result.completedTasks);

    case "needs_clarification":
      return result.followUpMessage;
  }
}

function formatScheduledTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

function quoteTaskTitle(title: string) {
  return `'${title}'`;
}

function renderScheduledItemsReply(input: {
  fallback: string;
  tasks: { id: string; title: string }[];
  scheduleBlocks: { taskId: string; startAt: string }[];
  timeZone: string;
}) {
  const taskTitlesById = new Map(input.tasks.map((task) => [task.id, task.title]));
  const items = input.scheduleBlocks
    .map((block) => {
      const title = taskTitlesById.get(block.taskId);

      if (!title) {
        return null;
      }

      return `${quoteTaskTitle(title)} for ${formatScheduledTime(block.startAt, input.timeZone)}`;
    })
    .filter((item): item is string => item !== null);

  if (items.length === 0) {
    return input.fallback;
  }

  if (items.length === 1) {
    return `Scheduled ${items[0]}.`;
  }

  return `Scheduled:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function renderCompletedTasksReply(tasks: { title: string }[]) {
  if (tasks.length === 0) {
    return "Marked it as done.";
  }

  if (tasks.length === 1) {
    const [task] = tasks;

    if (!task) {
      return "Marked it as done.";
    }

    return `Marked ${quoteTaskTitle(task.title)} as done.`;
  }

  return `Marked as done:\n${tasks.map((task) => `- ${quoteTaskTitle(task.title)}`).join("\n")}`;
}
