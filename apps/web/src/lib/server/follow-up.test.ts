import {
  type FollowUpRuntimeStore,
  getDefaultFollowUpRuntimeStore,
  getDefaultInboxProcessingStore,
  listOutgoingBotEventsForTests,
  listTasksForTests,
  resetInboxProcessingStoreForTests,
  resetIncomingTelegramIngressStoreForTests,
  seedInboxItemForProcessingTests,
} from "@atlas/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runBundledFollowUps } from "./follow-up";

async function seedScheduledTasks(
  titles: string[],
  inboxItemId: string,
  scheduledEndAt: string,
) {
  const store = getDefaultInboxProcessingStore();

  seedInboxItemForProcessingTests({
    id: inboxItemId,
    userId: "123",
    sourceEventId: `${inboxItemId}-event`,
    rawText: "schedule it",
    normalizedText: "schedule it",
    processingStatus: "received",
    linkedTaskIds: [],
    createdAt: "2026-03-20T16:00:00.000Z",
  });

  await store.saveTaskCaptureResult({
    inboxItemId,
    confidence: 1,
    plannerRun: {
      id: "ignored",
      userId: "123",
      inboxItemId,
      version: "test",
      modelInput: {},
      modelOutput: {},
      confidence: 1,
    } as never,
    tasks: titles.map((title, index) => ({
      alias: `${inboxItemId}_task_${index + 1}`,
      task: {
        userId: "123",
        sourceInboxItemId: inboxItemId,
        lastInboxItemId: inboxItemId,
        title,
        lifecycleState: "pending_schedule",
        externalCalendarEventId: null,
        externalCalendarId: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: null,
        rescheduleCount: 0,
        lastFollowupAt: null,
        followupReminderSentAt: null,
        completedAt: null,
        archivedAt: null,
        priority: "medium",
        urgency: "medium",
      },
    })),
    scheduleBlocks: titles.map((_, index) => ({
      id: `${inboxItemId}-event-${index + 1}`,
      userId: "123",
      taskId: `${inboxItemId}_task_${index + 1}`,
      startAt: "2026-03-20T16:00:00.000Z",
      endAt: scheduledEndAt,
      confidence: 1,
      reason: "test",
      rescheduleCount: 0,
      externalCalendarId: "primary",
    })),
    followUpMessage: "Scheduled it.",
  });

  return listTasksForTests()
    .filter((task) => task.sourceInboxItemId === inboxItemId)
    .map((task) => task.id);
}

describe("runBundledFollowUps", () => {
  beforeEach(() => {
    resetIncomingTelegramIngressStoreForTests();
    resetInboxProcessingStoreForTests();
  });

  it("sends one merged bundle for new initial tasks and older reminder-due tasks", async () => {
    const followUpStore = getDefaultFollowUpRuntimeStore();
    const sender = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        message_id: 88,
        date: 1_700_000_000,
        chat: {
          id: "123",
          type: "private",
        },
        text: "sent",
      },
    });

    const firstTaskIds = await seedScheduledTasks(
      [
        "Review launch checklist",
        "Send investor update",
        "Prep customer summary",
      ],
      "inbox-a",
      "2026-03-20T17:00:00.000Z",
    );

    await followUpStore.markFollowUpSent(
      firstTaskIds.slice(0, 2),
      "2026-03-20T17:00:00.000Z",
    );

    const result = await runBundledFollowUps("2026-03-20T19:00:00.000Z", {
      store: followUpStore,
      sender,
    });

    expect(result).toMatchObject({
      accepted: true,
      sentBundles: 1,
      skippedActiveTurns: 0,
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith({
      chatId: "123",
      text: "Checking in on these:\n1. Review launch checklist\n2. Send investor update\n3. Prep customer summary",
    });

    expect(
      listTasksForTests().find((task) => task.id === firstTaskIds[0]),
    ).toMatchObject({
      lifecycleState: "awaiting_followup",
      followupReminderSentAt: "2026-03-20T19:00:00.000Z",
    });
    expect(
      listTasksForTests().find((task) => task.id === firstTaskIds[1]),
    ).toMatchObject({
      lifecycleState: "awaiting_followup",
      followupReminderSentAt: "2026-03-20T19:00:00.000Z",
    });
    expect(
      listTasksForTests().find((task) => task.id === firstTaskIds[2]),
    ).toMatchObject({
      lifecycleState: "awaiting_followup",
      lastFollowupAt: "2026-03-20T19:00:00.000Z",
      followupReminderSentAt: null,
    });

    expect(listOutgoingBotEventsForTests()[0]?.payload).toMatchObject({
      kind: "initial",
      taskIds: firstTaskIds,
    });
  });

  it("keeps older unresolved tasks visible when newer initial tasks become due later", async () => {
    const followUpStore = getDefaultFollowUpRuntimeStore();
    const sender = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        message_id: 88,
        date: 1_700_000_000,
        chat: {
          id: "123",
          type: "private",
        },
        text: "sent",
      },
    });

    const initialTaskIds = await seedScheduledTasks(
      ["Task 1", "Task 2"],
      "inbox-a",
      "2026-03-20T17:00:00.000Z",
    );
    await followUpStore.markFollowUpSent(
      initialTaskIds,
      "2026-03-20T17:00:00.000Z",
    );

    await runBundledFollowUps("2026-03-20T19:00:00.000Z", {
      store: followUpStore,
      sender,
    });

    const laterTaskIds = await seedScheduledTasks(
      ["Task 3"],
      "inbox-b",
      "2026-03-20T20:00:00.000Z",
    );

    await runBundledFollowUps("2026-03-20T21:00:00.000Z", {
      store: followUpStore,
      sender,
    });

    expect(sender).toHaveBeenNthCalledWith(2, {
      chatId: "123",
      text: "Checking in on these:\n1. Task 1\n2. Task 2\n3. Task 3",
    });
    expect(listOutgoingBotEventsForTests()[1]?.payload).toMatchObject({
      kind: "initial",
      taskIds: [...initialTaskIds, ...laterTaskIds],
    });
  });

  it("deduplicates identical follow-up bundles across repeated runner attempts", async () => {
    const reservedKeys = new Set<string>();
    const deliveryStore = {
      reserveOutgoingIfAbsent: vi.fn(async (event) => {
        if (reservedKeys.has(event.idempotencyKey)) {
          return { status: "duplicate" as const };
        }

        reservedKeys.add(event.idempotencyKey);
        return { status: "reserved" as const, eventId: "event-1" };
      }),
      updateOutgoing: vi.fn(async () => undefined),
    };
    const sender = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        message_id: 88,
        date: 1_700_000_000,
        chat: {
          id: "123",
          type: "private",
        },
        text: "sent",
      },
    });
    const dueTask = {
      id: "task-1",
      userId: "123",
      sourceInboxItemId: "inbox-a",
      lastInboxItemId: "inbox-a",
      title: "Review launch checklist",
      lifecycleState: "scheduled" as const,
      externalCalendarEventId: null,
      externalCalendarId: null,
      scheduledStartAt: "2026-03-20T16:00:00.000Z",
      scheduledEndAt: "2026-03-20T17:00:00.000Z",
      calendarSyncStatus: "in_sync" as const,
      calendarSyncUpdatedAt: null,
      rescheduleCount: 0,
      lastFollowupAt: null,
      followupReminderSentAt: null,
      completedAt: null,
      archivedAt: null,
      priority: "medium" as const,
      urgency: "medium" as const,
      createdAt: "2026-03-20T16:00:00.000Z",
      dueType: "initial" as const,
    };
    const store: FollowUpRuntimeStore = {
      listDueFollowUpTasks: vi.fn(async () => [dueTask]),
      listOutstandingFollowUpTasks: vi.fn(async () => []),
      hasInFlightInboxItem: vi.fn(async () => false),
      markFollowUpSent: vi.fn(async () => undefined),
      markFollowUpReminderSent: vi.fn(async () => undefined),
    };

    await runBundledFollowUps("2026-03-20T19:00:00.000Z", {
      store,
      deliveryStore,
      sender,
    });
    await runBundledFollowUps("2026-03-20T19:00:00.000Z", {
      store,
      deliveryStore,
      sender,
    });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(deliveryStore.reserveOutgoingIfAbsent).toHaveBeenCalledTimes(2);
    expect(deliveryStore.reserveOutgoingIfAbsent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: "telegram:followup:inbox-item:initial:task-1",
      }),
    );
    expect(deliveryStore.reserveOutgoingIfAbsent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: "telegram:followup:inbox-item:initial:task-1",
      }),
    );
  });
});
