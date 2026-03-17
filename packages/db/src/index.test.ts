import { describe, expect, it } from "vitest";

import {
  getDefaultInboxProcessingStore,
  getRepositoryHealth,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  listOutgoingBotEventsForTests,
  listRecentConversationTurns,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  recordIncomingTelegramMessageIfNew,
  recordOutgoingTelegramMessageIfNew,
  resetInboxProcessingStoreForTests,
  resetIncomingTelegramIngressStoreForTests,
  seedInboxItemForProcessingTests,
  updateOutgoingTelegramMessage
} from "./index";

describe("db package", () => {
  it("reports repositories as unconfigured without a Postgres DATABASE_URL", () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    expect(getRepositoryHealth()).toEqual({
      status: "unconfigured",
      message: "Database repositories require a Postgres DATABASE_URL outside tests."
    });

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
      return;
    }

    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("records a first-seen incoming Telegram message as both event and inbox item", async () => {
    resetIncomingTelegramIngressStoreForTests();
    resetInboxProcessingStoreForTests();

    const result = await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:42",
      payload: {
        update_id: 42
      },
      rawText: " Review   launch checklist ",
      normalizedText: "Review launch checklist"
    });

    expect(result.status).toBe("recorded");
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
  });

  it("deduplicates repeated outgoing Telegram message events", async () => {
    resetIncomingTelegramIngressStoreForTests();

    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:inbox-item:inbox-1",
      payload: {
        chatId: "999",
        text: "Captured and scheduled Review launch checklist."
      },
      retryState: "sending"
    });

    const duplicate = await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:inbox-item:inbox-1",
      payload: {
        chatId: "999",
        text: "Captured and scheduled Review launch checklist."
      },
      retryState: "sent"
    });

    expect(duplicate).toEqual({
      status: "duplicate"
    });
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
  });

  it("updates a reserved outgoing Telegram message event after delivery", async () => {
    resetIncomingTelegramIngressStoreForTests();

    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:inbox-item:inbox-1",
      payload: {
        chatId: "999",
        text: "Captured and scheduled Review launch checklist.",
        attempts: 0
      },
      retryState: "sending"
    });

    await updateOutgoingTelegramMessage({
      idempotencyKey: "telegram:followup:inbox-item:inbox-1",
      payload: {
        chatId: "999",
        text: "Captured and scheduled Review launch checklist.",
        attempts: 1
      },
      retryState: "sent"
    });

    expect(listOutgoingBotEventsForTests()[0]).toMatchObject({
      retryState: "sent",
      payload: {
        attempts: 1
      }
    });
  });

  it("lists recent conversation turns in ascending order and excludes unsent assistant messages", async () => {
    resetIncomingTelegramIngressStoreForTests();

    await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:100",
      payload: {
        update_id: 100
      },
      rawText: "First user turn",
      normalizedText: "First user turn"
    });
    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:1",
      payload: {
        chatId: "999",
        text: "Reserved assistant turn",
        attempts: 0
      },
      retryState: "sending"
    });
    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:2",
      payload: {
        chatId: "999",
        text: "Sent assistant turn",
        attempts: 0
      },
      retryState: "sending"
    });
    await updateOutgoingTelegramMessage({
      idempotencyKey: "telegram:followup:2",
      payload: {
        chatId: "999",
        text: "Sent assistant turn",
        attempts: 1
      },
      retryState: "sent"
    });
    await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:101",
      payload: {
        update_id: 101
      },
      rawText: "Second user turn",
      normalizedText: "Second user turn"
    });

    const turns = await listRecentConversationTurns("123", 6);

    expect(turns.map((turn) => `${turn.role}:${turn.text}`)).toEqual([
      "user:First user turn",
      "user:Second user turn",
      "assistant:Sent assistant turn"
    ]);
  });

  it("limits recent conversation turns to the last six items", async () => {
    resetIncomingTelegramIngressStoreForTests();

    for (let index = 0; index < 8; index += 1) {
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: `telegram:webhook:update:${200 + index}`,
        payload: {
          update_id: 200 + index
        },
        rawText: `Turn ${index + 1}`,
        normalizedText: `Turn ${index + 1}`
      });
    }

    const turns = await listRecentConversationTurns("123", 6);

    expect(turns).toHaveLength(6);
    expect(turns.map((turn) => turn.text)).toEqual([
      "Turn 3",
      "Turn 4",
      "Turn 5",
      "Turn 6",
      "Turn 7",
      "Turn 8"
    ]);
  });

  it("stores planner-backed scheduling on task rows and derives schedule blocks from them", async () => {
    resetInboxProcessingStoreForTests();
    seedInboxItemForProcessingTests({
      id: "inbox-1",
      userId: "123",
      sourceEventId: "event-1",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const store = getDefaultInboxProcessingStore();
    await store.markInboxProcessing("inbox-1");
    const result = await store.saveTaskCaptureResult({
      inboxItemId: "inbox-1",
      confidence: 0.88,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-1",
        version: "test-v1",
        modelInput: {},
        modelOutput: {},
        confidence: 0.88
      },
      tasks: [
        {
          alias: "new_task_1",
          task: {
            userId: "123",
            sourceInboxItemId: "inbox-1",
            lastInboxItemId: "inbox-1",
            title: "Review launch checklist",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium"
          }
        }
      ],
      scheduleBlocks: [
        {
          id: "event-1",
          userId: "123",
          taskId: "new_task_1",
          startAt: "2026-03-13T17:00:00.000Z",
          endAt: "2026-03-13T18:00:00.000Z",
          confidence: 0.8,
          reason: "Scheduled from task capture.",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: "Captured and scheduled Review launch checklist."
    });

    expect(result.outcome).toBe("planned");
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()[0]).toMatchObject({
      lifecycleState: "scheduled",
      externalCalendarEventId: "event-1",
      externalCalendarId: "primary",
      scheduledStartAt: "2026-03-13T17:00:00.000Z",
      scheduledEndAt: "2026-03-13T18:00:00.000Z",
      rescheduleCount: 0
    });
    expect("scheduleBlocks" in result ? result.scheduleBlocks[0] : null).toMatchObject({
      id: "event-1",
      taskId: listTasksForTests()[0]?.id,
      confidence: 0.8,
      reason: "Scheduled from task capture.",
      externalCalendarId: "primary"
    });
    expect(listScheduleBlocksForTests()[0]).toMatchObject({
      id: "event-1",
      taskId: listTasksForTests()[0]?.id
    });
  });

  it("keeps reschedule count at zero when first scheduling an existing pending task", async () => {
    resetInboxProcessingStoreForTests();
    seedInboxItemForProcessingTests({
      id: "inbox-create",
      userId: "123",
      sourceEventId: "event-create",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const store = getDefaultInboxProcessingStore();
    await store.saveTaskCaptureResult({
      inboxItemId: "inbox-create",
      confidence: 0.88,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-create",
        version: "test-v1",
        modelInput: {},
        modelOutput: {},
        confidence: 0.88
      },
      tasks: [
        {
          alias: "new_task_1",
          task: {
            userId: "123",
            sourceInboxItemId: "inbox-create",
            lastInboxItemId: "inbox-create",
            title: "Review launch checklist",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium"
          }
        }
      ],
      scheduleBlocks: [],
      followUpMessage: "Captured Review launch checklist."
    });

    const createdTask = listTasksForTests()[0];
    seedInboxItemForProcessingTests({
      id: "inbox-first-schedule",
      userId: "123",
      sourceEventId: "event-first-schedule",
      rawText: "schedule it",
      normalizedText: "schedule it",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await store.saveScheduleRequestResult({
      inboxItemId: "inbox-first-schedule",
      confidence: 0.9,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-first-schedule",
        version: "test-v1",
        modelInput: {},
        modelOutput: {},
        confidence: 0.9
      },
      taskIds: [createdTask!.id],
      scheduleBlocks: [
        {
          id: "event-2",
          userId: "123",
          taskId: createdTask!.id,
          startAt: "2026-03-14T17:00:00.000Z",
          endAt: "2026-03-14T18:00:00.000Z",
          confidence: 0.8,
          reason: "First schedule for existing task.",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: "Scheduled it."
    });

    expect(listTasksForTests()[0]).toMatchObject({
      lifecycleState: "scheduled",
      externalCalendarEventId: "event-2",
      rescheduleCount: 0
    });
  });

  it("increments task reschedule count when updating the same calendar event", async () => {
    resetInboxProcessingStoreForTests();
    seedInboxItemForProcessingTests({
      id: "inbox-create-scheduled",
      userId: "123",
      sourceEventId: "event-create-scheduled",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const store = getDefaultInboxProcessingStore();
    await store.saveTaskCaptureResult({
      inboxItemId: "inbox-create-scheduled",
      confidence: 0.88,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-create-scheduled",
        version: "test-v1",
        modelInput: {},
        modelOutput: {},
        confidence: 0.88
      },
      tasks: [
        {
          alias: "new_task_1",
          task: {
            userId: "123",
            sourceInboxItemId: "inbox-create-scheduled",
            lastInboxItemId: "inbox-create-scheduled",
            title: "Review launch checklist",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium"
          }
        }
      ],
      scheduleBlocks: [
        {
          id: "event-3",
          userId: "123",
          taskId: "new_task_1",
          startAt: "2026-03-13T17:00:00.000Z",
          endAt: "2026-03-13T18:00:00.000Z",
          confidence: 0.8,
          reason: "Initial schedule.",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: "Captured and scheduled Review launch checklist."
    });

    const scheduledTask = listTasksForTests()[0];
    seedInboxItemForProcessingTests({
      id: "inbox-reschedule-existing",
      userId: "123",
      sourceEventId: "event-reschedule-existing",
      rawText: "schedule it for tomorrow",
      normalizedText: "schedule it for tomorrow",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await store.saveScheduleRequestResult({
      inboxItemId: "inbox-reschedule-existing",
      confidence: 0.9,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-reschedule-existing",
        version: "test-v1",
        modelInput: {},
        modelOutput: {},
        confidence: 0.9
      },
      taskIds: [scheduledTask!.id],
      scheduleBlocks: [
        {
          id: "event-3",
          userId: "123",
          taskId: scheduledTask!.id,
          startAt: "2026-03-14T17:00:00.000Z",
          endAt: "2026-03-14T18:00:00.000Z",
          confidence: 0.8,
          reason: "Replacement schedule for existing task.",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: "Rescheduled it."
    });

    expect(listTasksForTests()[0]).toMatchObject({
      lastInboxItemId: "inbox-reschedule-existing",
      lifecycleState: "scheduled",
      externalCalendarEventId: "event-3",
      scheduledStartAt: "2026-03-14T17:00:00.000Z",
      rescheduleCount: 1
    });
  });

  it("preserves write-time schedule block metadata in in-memory mutation results", async () => {
    resetInboxProcessingStoreForTests();
    seedInboxItemForProcessingTests({
      id: "inbox-parity",
      userId: "123",
      sourceEventId: "event-parity",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const store = getDefaultInboxProcessingStore();
    await store.markInboxProcessing("inbox-parity");
    const result = await store.saveTaskCaptureResult({
      inboxItemId: "inbox-parity",
      confidence: 0.91,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-parity",
        version: "test-v1",
        modelInput: {},
        modelOutput: {},
        confidence: 0.91
      },
      tasks: [
        {
          alias: "new_task_1",
          task: {
            userId: "123",
            sourceInboxItemId: "inbox-parity",
            lastInboxItemId: "inbox-parity",
            title: "Review launch checklist",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium"
          }
        }
      ],
      scheduleBlocks: [
        {
          id: "event-parity",
          userId: "123",
          taskId: "new_task_1",
          startAt: "2026-03-13T17:00:00.000Z",
          endAt: "2026-03-13T18:00:00.000Z",
          confidence: 0.91,
          reason: "Planner-specific reason.",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: "Captured and scheduled Review launch checklist."
    });

    expect("scheduleBlocks" in result ? result.scheduleBlocks[0] : null).toMatchObject({
      id: "event-parity",
      confidence: 0.91,
      reason: "Planner-specific reason."
    });
  });
});
