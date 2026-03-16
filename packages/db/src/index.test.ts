import { describe, expect, it } from "vitest";

import {
  getRepositoryHealth,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
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
            lastInboxItemId: "inbox-1",
            title: "Review launch checklist",
            lifecycleState: "scheduling",
            currentCommitmentId: null,
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
    expect(listTasksForTests()[0]).toMatchObject({
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-1",
      lifecycleState: "scheduled",
      currentCommitmentId: "00000000-0000-4000-8000-000000000001",
      rescheduleCount: 0
    });
  });

  it("keeps reschedule count at zero when first scheduling an unscheduled existing task", async () => {
    resetInboxProcessingStoreForTests();

    seedInboxItemForProcessingTests({
      id: "inbox-create-unscheduled",
      userId: "123",
      sourceEventId: "event-create-unscheduled",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const store = getDefaultInboxProcessingStore();
    await store.saveTaskCaptureResult({
      inboxItemId: "inbox-create-unscheduled",
      confidence: 0.88,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-create-unscheduled",
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
            sourceInboxItemId: "inbox-create-unscheduled",
            lastInboxItemId: "inbox-create-unscheduled",
            title: "Review launch checklist",
            lifecycleState: "scheduling",
            currentCommitmentId: null,
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
    expect(createdTask).toMatchObject({
      lifecycleState: "scheduling",
      currentCommitmentId: null,
      rescheduleCount: 0
    });

    seedInboxItemForProcessingTests({
      id: "inbox-first-schedule",
      userId: "123",
      sourceEventId: "event-first-schedule",
      rawText: "schedule it",
      normalizedText: "schedule it",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await store.saveScheduleRequestResult({
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
          id: "00000000-0000-4000-8000-000000000002",
          userId: "123",
          taskId: createdTask!.id,
          startAt: "2026-03-14T17:00:00.000Z",
          endAt: "2026-03-14T18:00:00.000Z",
          confidence: 0.8,
          reason: "First schedule for existing task.",
          rescheduleCount: 0,
          externalCalendarId: null
        }
      ],
      followUpMessage: "Scheduled it."
    });

    expect(result.outcome).toBe("scheduled_existing_tasks");
    expect(listTasksForTests()[0]).toMatchObject({
      lastInboxItemId: "inbox-first-schedule",
      lifecycleState: "scheduled",
      currentCommitmentId: "00000000-0000-4000-8000-000000000002",
      rescheduleCount: 0
    });
  });

  it("increments task reschedule count when replacing an existing current commitment", async () => {
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
            lifecycleState: "scheduling",
            currentCommitmentId: null,
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
          id: "00000000-0000-4000-8000-000000000003",
          userId: "123",
          taskId: "new_task_1",
          startAt: "2026-03-13T17:00:00.000Z",
          endAt: "2026-03-13T18:00:00.000Z",
          confidence: 0.8,
          reason: "Initial schedule.",
          rescheduleCount: 0,
          externalCalendarId: null
        }
      ],
      followUpMessage: "Captured and scheduled Review launch checklist."
    });

    const scheduledTask = listTasksForTests()[0];
    expect(scheduledTask).toMatchObject({
      currentCommitmentId: "00000000-0000-4000-8000-000000000003",
      rescheduleCount: 0
    });

    seedInboxItemForProcessingTests({
      id: "inbox-reschedule-existing",
      userId: "123",
      sourceEventId: "event-reschedule-existing",
      rawText: "schedule it for tomorrow",
      normalizedText: "schedule it for tomorrow",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await store.saveScheduleRequestResult({
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
          id: "00000000-0000-4000-8000-000000000004",
          userId: "123",
          taskId: scheduledTask!.id,
          startAt: "2026-03-14T17:00:00.000Z",
          endAt: "2026-03-14T18:00:00.000Z",
          confidence: 0.8,
          reason: "Replacement schedule for existing task.",
          rescheduleCount: 0,
          externalCalendarId: null
        }
      ],
      followUpMessage: "Rescheduled it."
    });

    expect(result.outcome).toBe("scheduled_existing_tasks");
    expect(listTasksForTests()[0]).toMatchObject({
      lastInboxItemId: "inbox-reschedule-existing",
      lifecycleState: "scheduled",
      currentCommitmentId: "00000000-0000-4000-8000-000000000004",
      rescheduleCount: 1
    });
  });
});
