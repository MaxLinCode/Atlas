import { describe, expect, it } from "vitest";

import {
  decryptCalendarCredential,
  encryptCalendarCredential,
  appendConversationTurn,
  getDefaultFollowUpRuntimeStore,
  getLatestFollowUpBundleContext,
  getDefaultGoogleCalendarConnectionStore,
  getDefaultInboxProcessingStore,
  getRepositoryHealth,
  loadConversationState,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  listOutgoingBotEventsForTests,
  listRecentConversationTurns,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  recordIncomingTelegramMessageIfNew,
  recordOutgoingTelegramMessageIfNew,
  resetConversationStateStoreForTests,
  resetInboxProcessingStoreForTests,
  resetGoogleCalendarConnectionStoreForTests,
  resetIncomingTelegramIngressStoreForTests,
  saveConversationState,
  seedInboxItemForProcessingTests,
  updateOutgoingTelegramMessage
} from "./index";

describe("db package", () => {
  process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

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
      normalizedText: "Review launch checklist",
      createdAt: "2026-03-19T16:00:00.000Z"
    });

    expect(result.status).toBe("recorded");
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listIncomingBotEventsForTests()[0]?.createdAt).toBe("2026-03-19T16:00:00.000Z");
    expect(listInboxItemsForTests()[0]?.createdAt).toBe("2026-03-19T16:00:00.000Z");
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

  it("reads the latest sent followup bundle context from outgoing bot events", async () => {
    resetIncomingTelegramIngressStoreForTests();

    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:bundle-1",
      payload: {
        kind: "initial",
        taskIds: ["task-1", "task-2"],
        items: [
          { number: 1, taskId: "task-1", title: "Review launch checklist" },
          { number: 2, taskId: "task-2", title: "Send update" }
        ],
        text: "Checking in"
      },
      retryState: "sending"
    });
    await updateOutgoingTelegramMessage({
      idempotencyKey: "telegram:followup:bundle-1",
      payload: {
        kind: "initial",
        taskIds: ["task-1", "task-2"],
        items: [
          { number: 1, taskId: "task-1", title: "Review launch checklist" },
          { number: 2, taskId: "task-2", title: "Send update" }
        ],
        text: "Checking in",
        attempts: 1
      },
      retryState: "sent"
    });

    await expect(getLatestFollowUpBundleContext("123")).resolves.toMatchObject({
      kind: "initial",
      taskIds: ["task-1", "task-2"],
      items: [{ number: 1, taskId: "task-1" }, { number: 2, taskId: "task-2" }]
    });
  });

  it("stores explicit conversation transcript, entity registry, and discourse state", async () => {
    resetConversationStateStoreForTests();

    await appendConversationTurn({
      userId: "123",
      role: "user",
      text: "Could we move that after lunch?",
      createdAt: "2026-03-20T16:00:00.000Z"
    });
    await saveConversationState({
      userId: "123",
      summaryText: "The user is discussing a move after lunch.",
      mode: "conversation_then_mutation",
      entityRegistry: [
        {
          id: "entity-1",
          conversationId: "placeholder",
          kind: "proposal_option",
          label: "Move the dentist reminder after lunch.",
          status: "active",
          createdAt: "2026-03-20T16:01:00.000Z",
          updatedAt: "2026-03-20T16:01:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "It sounds like you want to move the dentist reminder after lunch.",
            slotSnapshot: {}
          }
        }
      ],
      discourseState: {
        focus_entity_id: "entity-1",
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        mode: "planning"
      },
      updatedAt: "2026-03-20T16:01:00.000Z"
    });

    const state = await loadConversationState("123", 6);

    expect(state).toMatchObject({
      conversation: {
        userId: "123",
        summaryText: "The user is discussing a move after lunch.",
        mode: "conversation_then_mutation"
      },
      transcript: [
        {
          role: "user",
          text: "Could we move that after lunch?"
        }
      ],
      entityRegistry: [
        {
          kind: "proposal_option",
          label: "Move the dentist reminder after lunch."
        }
      ],
      discourseState: {
        focus_entity_id: "entity-1",
        last_user_mentioned_entity_ids: []
      }
    });
    expect(state?.entityRegistry[0]?.conversationId).toBe(state?.conversation.id);
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

  it("tracks due followups and reminder timestamps on tasks", async () => {
    resetInboxProcessingStoreForTests();
    const store = getDefaultInboxProcessingStore();
    const followUpStore = getDefaultFollowUpRuntimeStore();

    seedInboxItemForProcessingTests({
      id: "inbox-1",
      userId: "123",
      sourceEventId: "event-1",
      rawText: "schedule it",
      normalizedText: "schedule it",
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt: "2026-03-20T16:00:00.000Z"
    });

    await store.saveTaskCaptureResult({
      inboxItemId: "inbox-1",
      confidence: 1,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-1",
        version: "test",
        modelInput: {},
        modelOutput: {},
        confidence: 1
      },
      tasks: [
        {
          alias: "task_1",
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
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            followupReminderSentAt: null,
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
          taskId: "task_1",
          startAt: "2026-03-20T16:00:00.000Z",
          endAt: "2026-03-20T17:00:00.000Z",
          confidence: 1,
          reason: "test",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: "Scheduled it."
    });

    const due = await followUpStore.listDueFollowUpTasks("2026-03-20T17:00:00.000Z");
    expect(due).toHaveLength(1);
    expect(due[0]?.dueType).toBe("initial");

    await followUpStore.markFollowUpSent([due[0]!.id], "2026-03-20T17:00:00.000Z");
    await expect(followUpStore.listOutstandingFollowUpTasks("123")).resolves.toMatchObject([
      {
        lifecycleState: "awaiting_followup",
        lastFollowupAt: "2026-03-20T17:00:00.000Z"
      }
    ]);

    await followUpStore.markFollowUpReminderSent([due[0]!.id], "2026-03-20T19:00:00.000Z");
    await expect(followUpStore.listDueFollowUpTasks("2026-03-20T19:00:00.000Z")).resolves.toHaveLength(0);
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

  it("excludes Google Calendar link gate replies from recent conversation turns", async () => {
    resetIncomingTelegramIngressStoreForTests();

    await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:300",
      payload: {
        update_id: 300
      },
      rawText: "Schedule review launch checklist tomorrow",
      normalizedText: "Schedule review launch checklist tomorrow"
    });
    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_google_calendar_link",
      idempotencyKey: "telegram:lazy-link:300",
      payload: {
        chatId: "999",
        text: "[redacted Google Calendar connect link]",
        attempts: 0
      },
      retryState: "sending"
    });
    await updateOutgoingTelegramMessage({
      idempotencyKey: "telegram:lazy-link:300",
      payload: {
        chatId: "999",
        text: "[redacted Google Calendar connect link]",
        attempts: 1
      },
      retryState: "sent"
    });
    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:301",
      payload: {
        chatId: "999",
        text: "Scheduled for tomorrow at 9am.",
        attempts: 0
      },
      retryState: "sending"
    });
    await updateOutgoingTelegramMessage({
      idempotencyKey: "telegram:followup:301",
      payload: {
        chatId: "999",
        text: "Scheduled for tomorrow at 9am.",
        attempts: 1
      },
      retryState: "sent"
    });

    const turns = await listRecentConversationTurns("123", 6);

    expect(turns.map((turn) => `${turn.role}:${turn.text}`)).toEqual([
      "user:Schedule review launch checklist tomorrow",
      "assistant:Scheduled for tomorrow at 9am."
    ]);
  });

  it("excludes legacy persisted Google Calendar link copy from recent conversation turns", async () => {
    resetIncomingTelegramIngressStoreForTests();

    await recordIncomingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:400",
      payload: {
        update_id: 400
      },
      rawText: "Schedule taxes tomorrow",
      normalizedText: "Schedule taxes tomorrow"
    });
    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:400",
      payload: {
        chatId: "999",
        text: "I can do that, but I need access to your Google Calendar first. Connect here: [redacted Google Calendar connect link]. Once connected, send that again.",
        attempts: 0
      },
      retryState: "sending"
    });
    await updateOutgoingTelegramMessage({
      idempotencyKey: "telegram:followup:400",
      payload: {
        chatId: "999",
        text: "I can do that, but I need access to your Google Calendar first. Connect here: [redacted Google Calendar connect link]. Once connected, send that again.",
        attempts: 1
      },
      retryState: "sent"
    });

    const turns = await listRecentConversationTurns("123", 6);

    expect(turns.map((turn) => `${turn.role}:${turn.text}`)).toEqual([
      "user:Schedule taxes tomorrow"
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
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            followupReminderSentAt: null,
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
      calendarSyncStatus: "in_sync",
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
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            followupReminderSentAt: null,
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
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            followupReminderSentAt: null,
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
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            followupReminderSentAt: null,
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

  it("round-trips one linked Google Calendar account per user through the repository layer", async () => {
    resetGoogleCalendarConnectionStoreForTests();
    const store = getDefaultGoogleCalendarConnectionStore();

    await store.upsertConnection({
      userId: "123",
      providerAccountId: "google-user-1",
      email: "max@example.com",
      selectedCalendarId: "primary",
      selectedCalendarName: "Primary",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: "2026-03-20T17:00:00.000Z",
      scopes: ["calendar"],
      syncCursor: null,
      lastSyncedAt: null,
      revokedAt: null
    });

    await expect(store.getConnection("123")).resolves.toMatchObject({
      userId: "123",
      email: "max@example.com",
      selectedCalendarId: "primary"
    });
    await expect(store.getConnectionCredentials("123")).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token"
    });
  });

  it("encrypts and decrypts stored Google Calendar credentials with versioned ciphertext", () => {
    const ciphertext = encryptCalendarCredential("access-token", Buffer.alloc(32, 9).toString("base64"));

    expect(ciphertext.startsWith("v1:")).toBe(true);
    expect(ciphertext).not.toContain("access-token");
    expect(decryptCalendarCredential(ciphertext, Buffer.alloc(32, 9).toString("base64"))).toBe("access-token");
  });
});
