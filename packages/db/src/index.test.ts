import { describe, expect, it } from "vitest";

import {
  getRepositoryHealth,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  listOutgoingBotEventsForTests,
  recordOutgoingTelegramMessageIfNew,
  updateOutgoingTelegramMessage,
  recordIncomingTelegramMessageIfNew,
  seedInboxItemForProcessingTests,
  getDefaultInboxProcessingStore,
  resetInboxProcessingStoreForTests,
  resetIncomingTelegramIngressStoreForTests
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

  it("returns duplicate for repeated idempotency keys", async () => {
    resetIncomingTelegramIngressStoreForTests();

    await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:42",
      payload: {
        update_id: 42
      },
      rawText: " Review   launch checklist ",
      normalizedText: "Review launch checklist"
    });

    const duplicate = await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:42",
      payload: {
        update_id: 42
      },
      rawText: " Review   launch checklist ",
      normalizedText: "Review launch checklist"
    });

    expect(duplicate).toEqual({
      status: "duplicate"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
  });

  it("records a first-seen outgoing Telegram message event", async () => {
    resetIncomingTelegramIngressStoreForTests();

    const result = await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:inbox-item:inbox-1",
      payload: {
        chatId: "999",
        text: "Captured and scheduled Review launch checklist."
      },
      retryState: "sending"
    });

    expect(result.status).toBe("reserved");
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(listOutgoingBotEventsForTests()[0]?.retryState).toBe("sending");
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

  it("keeps distinct Telegram update ids as separate ingress events", async () => {
    resetIncomingTelegramIngressStoreForTests();

    await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:42",
      payload: {
        update_id: 42
      },
      rawText: "first",
      normalizedText: "first"
    });

    await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:43",
      payload: {
        update_id: 43
      },
      rawText: "second",
      normalizedText: "second"
    });

    expect(listIncomingBotEventsForTests()).toHaveLength(2);
    expect(listInboxItemsForTests()).toHaveLength(2);
  });

  it("treats concurrent duplicate deliveries as a single recorded ingress event", async () => {
    resetIncomingTelegramIngressStoreForTests();

    const [first, second] = await Promise.all([
      recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:42",
        payload: {
          update_id: 42
        },
        rawText: " Review   launch checklist ",
        normalizedText: "Review launch checklist"
      }),
      recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:42",
        payload: {
          update_id: 42
        },
        rawText: " Review   launch checklist ",
        normalizedText: "Review launch checklist"
      })
    ]);

    expect([first.status, second.status].sort()).toEqual(["duplicate", "recorded"]);
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
  });

  it("stores planner-run-backed task capture results in the in-memory processing repository", async () => {
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
        modelInput: {
          normalizedText: "Review launch checklist"
        },
        modelOutput: {
          intentType: "task_capture"
        },
        confidence: 0.88
      },
      tasks: [
        {
          alias: "new_task_1",
          task: {
            userId: "123",
            sourceInboxItemId: "inbox-1",
            title: "Review launch checklist",
            status: "open",
            priority: "medium",
            urgency: "medium"
          }
        }
      ],
      scheduleBlocks: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          userId: "123",
          taskId: "new_task_1",
          startAt: "2026-03-13T17:00:00.000Z",
          endAt: "2026-03-13T18:00:00.000Z",
          confidence: 0.8,
          reason: "Scheduled from task capture.",
          rescheduleCount: 0,
          externalCalendarId: null
        }
      ],
      followUpMessage: "Captured and scheduled Review launch checklist."
    });

    expect(result.outcome).toBe("planned");
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
  });
});
