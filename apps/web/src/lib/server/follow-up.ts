import type { Task } from "@atlas/core";
import {
  buildTelegramFollowUpIdempotencyKey
} from "@atlas/core";
import {
  getDefaultFollowUpRuntimeStore,
  type FollowUpDueTask,
  type FollowUpRuntimeStore,
  type OutgoingTelegramDeliveryStore
} from "@atlas/db";
import { sendTelegramMessage } from "@atlas/integrations";

import { sendTelegramMessageWithPersistence } from "./telegram-webhook-transport";

type FollowUpRunnerDependencies = {
  store?: FollowUpRuntimeStore;
  deliveryStore?: OutgoingTelegramDeliveryStore;
  sender?: typeof sendTelegramMessage;
};

export async function runBundledFollowUps(
  now = new Date().toISOString(),
  dependencies: FollowUpRunnerDependencies = {}
) {
  const store = dependencies.store ?? getDefaultFollowUpRuntimeStore();
  const dueTasks = await store.listDueFollowUpTasks(now);
  const tasksByUser = new Map<string, FollowUpDueTask[]>();

  for (const task of dueTasks) {
    const existing = tasksByUser.get(task.userId) ?? [];
    existing.push(task);
    tasksByUser.set(task.userId, existing);
  }

  let sentBundles = 0;
  let skippedActiveTurns = 0;

  for (const [userId, userTasks] of tasksByUser) {
    if (await store.hasInFlightInboxItem(userId)) {
      skippedActiveTurns += 1;
      continue;
    }

    const initialTasks = userTasks.filter((task) => task.dueType === "initial");
    const reminderTasks = userTasks.filter((task) => task.dueType === "reminder");

    if (initialTasks.length === 0 && reminderTasks.length === 0) {
      continue;
    }

    const outstanding = await store.listOutstandingFollowUpTasks(userId);
    const initialTaskIds = new Set(initialTasks.map((task) => task.id));
    const reminderTaskIds = new Set(reminderTasks.map((task) => task.id));
    const bundleTasks = mergeFollowUpBundleTasks(outstanding, initialTasks, reminderTasks);

    if (bundleTasks.length === 0) {
      continue;
    }

    const bundle = buildFollowUpBundle(bundleTasks, initialTasks.length > 0 ? "initial" : "reminder");
    const delivery = await sendFollowUpBundle(userId, bundle, dependencies);

    if (delivery.status === "failed") {
      continue;
    }

    if (initialTaskIds.size > 0) {
      await store.markFollowUpSent(Array.from(initialTaskIds), now);
    }

    if (reminderTaskIds.size > 0) {
      await store.markFollowUpReminderSent(Array.from(reminderTaskIds), now);
    }

    sentBundles += 1;
  }

  return {
    accepted: true,
    sentBundles,
    skippedActiveTurns
  };
}

function mergeFollowUpBundleTasks(
  outstanding: Task[],
  initialTasks: FollowUpDueTask[],
  reminderTasks: FollowUpDueTask[]
) {
  const tasksById = new Map<string, Pick<Task, "id" | "title" | "scheduledEndAt">>();

  for (const task of outstanding) {
    tasksById.set(task.id, task);
  }

  for (const task of initialTasks) {
    if (!tasksById.has(task.id)) {
      tasksById.set(task.id, task);
    }
  }

  for (const task of reminderTasks) {
    if (!tasksById.has(task.id)) {
      tasksById.set(task.id, task);
    }
  }

  return Array.from(tasksById.values());
}

export type RenderedFollowUpBundle = {
  kind: "initial" | "reminder";
  taskIds: string[];
  items: Array<{
    number: number;
    taskId: string;
    title: string;
  }>;
  text: string;
};

export function buildFollowUpBundle(tasks: Pick<Task, "id" | "title" | "scheduledEndAt">[], kind: "initial" | "reminder"): RenderedFollowUpBundle {
  const ordered = [...tasks].sort(
    (left, right) =>
      Date.parse(left.scheduledEndAt ?? new Date().toISOString()) -
      Date.parse(right.scheduledEndAt ?? new Date().toISOString())
  );
  const items = ordered.map((task, index) => ({
    number: index + 1,
    taskId: task.id,
    title: task.title
  }));

  return {
    kind,
    taskIds: items.map((item) => item.taskId),
    items,
    text:
      kind === "initial"
        ? `Checking in on these:\n${items.map((item) => `${item.number}. ${item.title}`).join("\n")}`
        : `Still open:\n${items.map((item) => `${item.number}. ${item.title}`).join("\n")}`
  };
}

async function sendFollowUpBundle(
  userId: string,
  bundle: RenderedFollowUpBundle,
  dependencies: FollowUpRunnerDependencies
) {
  const chatId = userId;

  return sendTelegramMessageWithPersistence(
    {
      userId,
      chatId,
      text: bundle.text,
      idempotencyKey: buildTelegramFollowUpIdempotencyKey(`${bundle.kind}:${bundle.taskIds.join(",")}`),
      bundle
    },
    {
      sender: dependencies.sender ?? sendTelegramMessage,
      ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {})
    }
  );
}
