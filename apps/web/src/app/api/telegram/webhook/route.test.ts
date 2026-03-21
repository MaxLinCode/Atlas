import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxPlanningOutput } from "@atlas/core";
import {
  getDefaultGoogleCalendarConnectionStore,
  getDefaultFollowUpRuntimeStore,
  getDefaultInboxProcessingStore,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  listOutgoingBotEventsForTests,
  recordIncomingTelegramMessageIfNew,
  recordOutgoingTelegramMessageIfNew,
  resetGoogleCalendarConnectionStoreForTests,
  resetInboxProcessingStoreForTests,
  resetIncomingTelegramIngressStoreForTests,
  seedInboxItemForProcessingTests,
  updateOutgoingTelegramMessage
} from "@atlas/db";
import { getDefaultCalendarAdapter, resetCalendarAdapterForTests } from "@atlas/integrations";

import { handleTelegramWebhook } from "@/lib/server/telegram-webhook";

const { editTelegramMessageMock, sendTelegramMessageMock, sendTelegramChatActionMock, routeTurnWithResponsesMock } =
  vi.hoisted(() => ({
    editTelegramMessageMock: vi.fn(),
  sendTelegramMessageMock: vi.fn(),
  sendTelegramChatActionMock: vi.fn(),
  routeTurnWithResponsesMock: vi.fn()
  }));

vi.mock("@atlas/integrations", async () => {
  const actual = await vi.importActual<typeof import("@atlas/integrations")>("@atlas/integrations");

  return {
    ...actual,
    getDefaultCalendarAdapter: () => actual.getDefaultCalendarAdapter(),
    planInboxItemWithResponses: async () => ({
      confidence: 0.9,
      summary: "Captured and scheduled Review launch checklist.",
      actions: [
        {
          type: "create_task",
          alias: "new_task_1",
          title: "Review launch checklist",
          priority: "medium",
          urgency: "medium"
        },
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "created_task",
            alias: "new_task_1"
          },
          scheduleConstraint: {
            dayReference: null,
            weekday: null,
            weekOffset: null,
            explicitHour: 9,
            minute: 0,
            preferredWindow: null,
            sourceText: "default next slot"
          },
          reason: "Schedule the new task in the next slot."
        }
      ]
    }),
    editTelegramMessage: editTelegramMessageMock,
    routeTurnWithResponses: routeTurnWithResponsesMock,
    sendTelegramChatAction: sendTelegramChatActionMock,
    sendTelegramMessage: sendTelegramMessageMock
  };
});

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS,
  APP_BASE_URL: process.env.APP_BASE_URL,
  GOOGLE_LINK_TOKEN_SECRET: process.env.GOOGLE_LINK_TOKEN_SECRET,
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY
};

function restoreEnv(name: keyof typeof ORIGINAL_ENV) {
  const value = ORIGINAL_ENV[name];

  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function buildRequest(body: unknown, secret = "test-webhook-secret") {
  return new Request("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TELEGRAM_SECRET_HEADER]: secret
    },
    body: JSON.stringify(body)
  });
}

async function seedOutstandingFollowUpBundle(titles: string[]) {
  const store = getDefaultInboxProcessingStore();
  const followUpStore = getDefaultFollowUpRuntimeStore();

  seedInboxItemForProcessingTests({
    id: "inbox-seed",
    userId: "123",
    sourceEventId: "seed-event",
    rawText: "schedule it",
    normalizedText: "schedule it",
    processingStatus: "received",
    linkedTaskIds: [],
    createdAt: "2026-03-20T16:00:00.000Z"
  });

  await store.saveTaskCaptureResult({
    inboxItemId: "inbox-seed",
    confidence: 1,
    plannerRun: {
      id: "ignored",
      userId: "123",
      inboxItemId: "inbox-seed",
      version: "test",
      modelInput: {},
      modelOutput: {},
      confidence: 1
    } as never,
    tasks: titles.map((title, index) => ({
      alias: `task_${index + 1}`,
      task: {
        userId: "123",
        sourceInboxItemId: "inbox-seed",
        lastInboxItemId: "inbox-seed",
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
        urgency: "medium"
      }
    })),
    scheduleBlocks: titles.map((_, index) => ({
      id: `event-${index + 1}`,
      userId: "123",
      taskId: `task_${index + 1}`,
      startAt: "2026-03-20T16:00:00.000Z",
      endAt: "2026-03-20T17:00:00.000Z",
      confidence: 1,
      reason: "test",
      rescheduleCount: 0,
      externalCalendarId: "primary"
    })),
    followUpMessage: "Scheduled it."
  });

  const taskIds = listTasksForTests().map((task) => task.id);
  await followUpStore.markFollowUpSent(taskIds, "2026-03-20T17:00:00.000Z");

  await recordOutgoingTelegramMessageIfNew({
    userId: "123",
    eventType: "telegram_followup_message",
    idempotencyKey: "telegram:followup:bundle-seed",
    payload: {
      kind: "initial",
      taskIds,
      items: taskIds.map((taskId, index) => ({ number: index + 1, taskId, title: titles[index] ?? `Task ${index + 1}` })),
      text: titles.map((title, index) => `${index + 1}. ${title}`).join("\n")
    },
    retryState: "sending"
  });
  await updateOutgoingTelegramMessage({
    idempotencyKey: "telegram:followup:bundle-seed",
    payload: {
      kind: "initial",
      taskIds,
      items: taskIds.map((taskId, index) => ({ number: index + 1, taskId, title: titles[index] ?? `Task ${index + 1}` })),
      text: titles.map((title, index) => `${index + 1}. ${title}`).join("\n"),
      attempts: 1
    },
    retryState: "sent"
  });

  return {
    store,
    followUpStore,
    taskIds
  };
}

afterEach(() => {
  restoreEnv("DATABASE_URL");
  restoreEnv("OPENAI_API_KEY");
  restoreEnv("TELEGRAM_BOT_TOKEN");
  restoreEnv("TELEGRAM_WEBHOOK_SECRET");
  restoreEnv("TELEGRAM_ALLOWED_USER_IDS");
  restoreEnv("APP_BASE_URL");
  restoreEnv("GOOGLE_LINK_TOKEN_SECRET");
  restoreEnv("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY");
});

beforeEach(async () => {
  process.env.DATABASE_URL = "postgres://atlas:atlas@localhost:5432/atlas";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.APP_BASE_URL = "https://atlas.example.com";
  process.env.GOOGLE_LINK_TOKEN_SECRET = "google-link-secret";
  process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  resetCalendarAdapterForTests();
  editTelegramMessageMock.mockReset();
  sendTelegramMessageMock.mockReset();
  sendTelegramChatActionMock.mockReset();
  routeTurnWithResponsesMock.mockReset();
  routeTurnWithResponsesMock.mockResolvedValue({
    route: "mutation",
    reason: "Direct scheduling request."
  });
  sendTelegramMessageMock.mockResolvedValue({
    ok: true,
    result: {
      message_id: 88,
      date: 1_700_000_000,
      chat: {
        id: "999",
        type: "private"
      },
      text: "Captured and scheduled Review launch checklist."
    }
  });
  editTelegramMessageMock.mockImplementation(async ({ chatId, messageId, text }) => ({
    ok: true,
    result: {
      message_id: messageId,
      date: 1_700_000_001,
      chat: {
        id: chatId,
        type: "private"
      },
      text
    }
  }));
  sendTelegramChatActionMock.mockResolvedValue(undefined);
  resetIncomingTelegramIngressStoreForTests();
  resetInboxProcessingStoreForTests();
  resetGoogleCalendarConnectionStoreForTests();
  await getDefaultGoogleCalendarConnectionStore().upsertConnection({
    userId: "123",
    providerAccountId: "google-user-1",
    email: "max@example.com",
    selectedCalendarId: "primary",
    selectedCalendarName: "Primary",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scopes: ["scope-a", "scope-b"],
    syncCursor: null,
    lastSyncedAt: null,
    revokedAt: null
  });
});

describe("telegram webhook route", () => {
  it("gates unlinked users before ingress persistence and sends a Google connect link", async () => {
    resetGoogleCalendarConnectionStoreForTests();

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 40,
        message: {
          message_id: 5,
          date: 1_700_000_000,
          text: "Schedule review launch checklist tomorrow at 9",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      lazyLinkRequired: true,
      outboundDelivery: {
        status: "sent",
        attempts: 1
      }
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: expect.stringContaining("I can do that, but I need access to your Google Calendar first. Connect here: https://atlas.example.com/google-calendar/connect?token=")
    });
    expect(listOutgoingBotEventsForTests()[0]).toMatchObject({
      eventType: "telegram_google_calendar_link",
      payload: {
        text: expect.not.stringContaining("token=")
      }
    });
    expect(listOutgoingBotEventsForTests()[0]).toMatchObject({
      payload: {
        text: expect.stringContaining("[redacted Google Calendar connect link]")
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(0);
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
  });

  it("binds numbered followup replies and marks the selected task done", async () => {
    const { store, followUpStore } = await seedOutstandingFollowUpBundle(["Review launch checklist"]);

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 41,
        message: {
          message_id: 6,
          date: 1_700_000_000,
          text: "1 done",
          chat: { id: 999, type: "private" },
          from: { id: 123, is_bot: false, first_name: "Max" }
        }
      }),
      {
        store,
        followUpStore,
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect((response.body as { processing: { outcome: string } }).processing.outcome).toBe("completed_tasks");
    expect(listTasksForTests()[0]).toMatchObject({
      lifecycleState: "done"
    });
  });

  it("accepts short natural-language followup replies that reference bundle numbers", async () => {
    const { store, followUpStore, taskIds } = await seedOutstandingFollowUpBundle(["Task 1", "Task 2"]);

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 142,
        message: {
          message_id: 107,
          date: 1_700_000_000,
          text: "finished 2",
          chat: { id: 999, type: "private" },
          from: { id: 123, is_bot: false, first_name: "Max" }
        }
      }),
      {
        store,
        followUpStore,
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect((response.body as { processing: { outcome: string } }).processing.outcome).toBe("completed_tasks");
    expect(listTasksForTests().find((task) => task.id === taskIds[0])).toMatchObject({
      lifecycleState: "awaiting_followup"
    });
    expect(listTasksForTests().find((task) => task.id === taskIds[1])).toMatchObject({
      lifecycleState: "done"
    });
  });

  it("accepts ordinal followup archive replies", async () => {
    const { store, followUpStore, taskIds } = await seedOutstandingFollowUpBundle(["Task 1", "Task 2"]);

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 143,
        message: {
          message_id: 108,
          date: 1_700_000_000,
          text: "archive the second one",
          chat: { id: 999, type: "private" },
          from: { id: 123, is_bot: false, first_name: "Max" }
        }
      }),
      {
        store,
        followUpStore,
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect((response.body as { processing: { outcome: string } }).processing.outcome).toBe("archived_tasks");
    expect(listTasksForTests().find((task) => task.id === taskIds[0])).toMatchObject({
      lifecycleState: "awaiting_followup"
    });
    expect(listTasksForTests().find((task) => task.id === taskIds[1])).toMatchObject({
      lifecycleState: "archived"
    });
  });

  it("asks for clarification on ambiguous followup replies with multiple unresolved items", async () => {
    const { store, followUpStore } = await seedOutstandingFollowUpBundle(["Task 1", "Task 2"]);

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 42,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: "done",
          chat: { id: 999, type: "private" },
          from: { id: 123, is_bot: false, first_name: "Max" }
        }
      }),
      {
        store,
        followUpStore,
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Which one do you mean? Reply with the number or numbers."
    });
  });

  it("lets mixed-intent messages fall through to the normal router even with outstanding followups", async () => {
    const { store, followUpStore } = await seedOutstandingFollowUpBundle(["Review launch checklist", "Send investor update"]);

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 144,
        message: {
          message_id: 109,
          date: 1_700_000_000,
          text: "1 done and schedule dentist tomorrow",
          chat: { id: 999, type: "private" },
          from: { id: 123, is_bot: false, first_name: "Max" }
        }
      }),
      {
        store,
        followUpStore,
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(routeTurnWithResponsesMock).toHaveBeenCalledTimes(1);
    expect((response.body as { processing: { outcome: string } }).processing.outcome).toBe("planned");
    expect(listTasksForTests().filter((task) => task.lifecycleState === "done")).toHaveLength(0);
  });

  it("also gates /start for unlinked users", async () => {
    resetGoogleCalendarConnectionStoreForTests();

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 41,
        message: {
          message_id: 6,
          date: 1_700_000_000,
          text: "/start",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      lazyLinkRequired: true
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listInboxItemsForTests()).toHaveLength(0);
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("rejects requests with the wrong Telegram webhook secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest(
        {
          update_id: 1
        },
        "wrong-secret"
      ),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(401);
    await expect(Promise.resolve(response.body)).resolves.toMatchObject({
      accepted: false,
      error: "invalid_webhook_secret"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listInboxItemsForTests()).toHaveLength(0);
  });

  it("rejects Telegram users that are not on the allowlist before persistence", async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "456";

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 41,
        message: {
          message_id: 6,
          date: 1_700_000_000,
          text: "Review launch checklist",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(403);
    await expect(Promise.resolve(response.body)).resolves.toMatchObject({
      accepted: false,
      error: "telegram_user_not_allowed"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listOutgoingBotEventsForTests()).toHaveLength(0);
    expect(listInboxItemsForTests()).toHaveLength(0);
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("accepts Telegram users that are on the allowlist", async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 42,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin",
            username: "maxl",
            language_code: "en"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
  });

  it("normalizes a Telegram text message and hands it to app services", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 42,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin",
            username: "maxl",
            language_code: "en"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    await expect(Promise.resolve(response.body)).resolves.toMatchObject({
      accepted: true,
      idempotencyKey: "telegram:webhook:update:42",
      ingestion: {
        source: "telegram",
        delivery: "webhook",
        updateId: 42,
        messageId: 7,
        chatId: "999",
        rawText: " Review   launch checklist ",
        normalizedText: "Review launch checklist",
        user: {
          telegramUserId: "123",
          displayName: "Max Lin",
          username: "maxl",
          languageCode: "en",
          chatType: "private"
        }
      },
      inboxItem: {
        userId: "123",
        rawText: " Review   launch checklist ",
        normalizedText: "Review launch checklist",
        processingStatus: "received",
        linkedTaskIds: []
      },
      processing: {
        outcome: "planned"
      },
      outboundDelivery: {
        status: "edited",
        attempts: 1
      }
    });
    expect(response.body).toMatchObject({
      outboundDelivery: {
        idempotencyKey: expect.any(String),
        message: {
          message_id: 88
        }
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
    expect(sendTelegramChatActionMock).toHaveBeenCalledWith({
      chatId: "999",
      action: "typing"
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Checking your schedule"
    });
    expect(editTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      messageId: 88,
      text: expect.stringContaining("Scheduled 'Review launch checklist'")
    });
  });

  it("preserves mutation behavior when the turn router explicitly returns mutation", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 46,
        message: {
          message_id: 11,
          date: 1_700_000_004,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        turnRouter: async () => ({
          route: "mutation",
          reason: "Direct scheduling request.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "mutation",
      processing: {
        outcome: "planned"
      },
      outboundDelivery: {
        status: "edited",
        attempts: 1
      }
    });
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(editTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("treats confirmed mutation turns as write-capable when recovery finds one concrete proposal", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:proposal-confirmed",
      payload: {
        chatId: "999",
        text: "Would you like me to schedule it at 3pm?",
        attempts: 0
      },
      retryState: "sending"
    });
    await updateOutgoingTelegramMessage({
      idempotencyKey: "telegram:followup:proposal-confirmed",
      payload: {
        chatId: "999",
        text: "Would you like me to schedule it at 3pm?",
        attempts: 1
      },
      retryState: "sent"
    });
    const planner = vi.fn(async (): Promise<InboxPlanningOutput> => ({
      confidence: 0.9,
      summary: "Scheduled the dentist reminder for 3pm.",
      actions: [
        {
          type: "create_task",
          alias: "new_task_1",
          title: "Dentist reminder",
          priority: "medium",
          urgency: "medium"
        },
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "created_task",
            alias: "new_task_1"
          },
          scheduleConstraint: {
            dayReference: null,
            weekday: null,
            weekOffset: null,
            explicitHour: 15,
            minute: 0,
            preferredWindow: null,
            sourceText: "at 3pm"
          },
          reason: "The user confirmed the proposed 3pm slot."
        }
      ]
    }));
    const confirmedMutationRecoverer = vi.fn(async () => ({
      outcome: "recovered" as const,
      recoveredText: "Schedule the dentist reminder at 3pm.",
      reason: "The user confirmed the concrete 3pm proposal.",
      userReplyMessage: "Got it - I've added 'Dentist reminder' to your schedule for today at 3pm."
    }));

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 52,
        message: {
          message_id: 17,
          date: 1_700_000_010,
          text: "Yes",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        planner,
        conversationMemorySummarizer: async () => ({
          summary: "The assistant proposed a concrete 3pm schedule and the user is now confirming it."
        }),
        confirmedMutationRecoverer,
        turnRouter: async () => ({
          route: "confirmed_mutation",
          reason: "The user is confirming a recent concrete proposal.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "confirmed_mutation",
      processing: {
        outcome: "planned"
      }
    });
    expect(confirmedMutationRecoverer).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: "Yes",
        recentTurns: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            text: "Would you like me to schedule it at 3pm?"
          }),
          expect.objectContaining({
            role: "user",
            text: "Yes"
          })
        ])
      })
    );
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxItem: expect.objectContaining({
          rawText: "Schedule the dentist reminder at 3pm.",
          normalizedText: "Schedule the dentist reminder at 3pm."
        })
      })
    );
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Applying that"
    });
    expect(editTelegramMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "999",
        messageId: 88,
        text: expect.stringContaining("Scheduled 'Dentist reminder'")
      })
    );
  });

  it("supports broader follow-up refinements in confirmed mutation turns", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const planner = vi.fn(async (): Promise<InboxPlanningOutput> => ({
      confidence: 0.88,
      summary: "Moved the scheduled review block one hour later.",
      actions: [
        {
          type: "move_schedule_block",
          blockRef: {
            alias: "schedule_block_1"
          },
          scheduleConstraint: {
            dayReference: null,
            weekday: null,
            weekOffset: null,
            explicitHour: 16,
            minute: 0,
            preferredWindow: null,
            sourceText: "1 hour later"
          },
          reason: "The user asked to push it 1 hour later."
        }
      ]
    }));

    seedInboxItemForProcessingTests({
      id: "inbox-existing",
      userId: "123",
      sourceEventId: "event-existing",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });
    await handleTelegramWebhook(
      buildRequest({
        update_id: 53,
        message: {
          message_id: 18,
          date: 1_700_000_011,
          text: "Review launch checklist",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );
    sendTelegramMessageMock.mockClear();
    editTelegramMessageMock.mockClear();

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 54,
        message: {
          message_id: 19,
          date: 1_700_000_012,
          text: "push it 1 hour later",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        planner,
        conversationMemorySummarizer: async () => ({
          summary: "The recent exchange includes one concrete proposal to move the existing review block one hour later."
        }),
        confirmedMutationRecoverer: async () => ({
          outcome: "recovered",
          recoveredText: "Move the scheduled review block 1 hour later.",
          reason: "The user refined the recent concrete proposal.",
          userReplyMessage: "Done - I've moved it to 4pm."
        }),
        turnRouter: async () => ({
          route: "confirmed_mutation",
          reason: "The user is refining a recent concrete proposal.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "confirmed_mutation",
      processing: {
        outcome: "updated_schedule"
      }
    });
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxItem: expect.objectContaining({
          rawText: "Move the scheduled review block 1 hour later."
        })
      })
    );
    expect(editTelegramMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "999",
        messageId: 88,
        text: expect.stringContaining("Moved it to")
      })
    );
  });

  it("completes a recent task from a confirmed mutation recovery turn", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    await handleTelegramWebhook(
      buildRequest({
        update_id: 56,
        message: {
          message_id: 21,
          date: 1_700_000_014,
          text: "Journaling session",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        planner: async (): Promise<InboxPlanningOutput> => ({
          confidence: 0.9,
          summary: "Scheduled Journaling session.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Journaling session",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ]
        })
      }
    );
    sendTelegramMessageMock.mockClear();
    editTelegramMessageMock.mockClear();

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 57,
        message: {
          message_id: 22,
          date: 1_700_000_015,
          text: "journal is done",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        planner: async (): Promise<InboxPlanningOutput> => ({
          confidence: 0.92,
          summary: "Marked the journaling session as done.",
          actions: [
            {
              type: "complete_task",
              taskRef: {
                kind: "existing_task",
                alias: "existing_task_1"
              },
              reason: "The user said the journaling session is done."
            }
          ]
        }),
        confirmedMutationRecoverer: async () => ({
          outcome: "recovered",
          recoveredText: "Mark the journaling session as done.",
          reason: "The latest turn clearly reports completion of the recent journaling task.",
          userReplyMessage: "Got it."
        }),
        turnRouter: async () => ({
          route: "confirmed_mutation",
          reason: "The latest turn clearly completes one recent task.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "confirmed_mutation",
      processing: {
        outcome: "completed_tasks"
      }
    });
    expect(listTasksForTests()).toHaveLength(1);
    expect(listTasksForTests()[0]).toMatchObject({
      title: "Journaling session",
      lifecycleState: "done",
      externalCalendarEventId: null,
      externalCalendarId: null
    });
    expect(editTelegramMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "999",
        messageId: 88,
        text: "Marked 'Journaling session' as done."
      })
    );
  });

  it("falls back to clarification when confirmed mutation recovery is ambiguous", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const planner = vi.fn();

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 55,
        message: {
          message_id: 20,
          date: 1_700_000_013,
          text: "Yes",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        planner,
        conversationMemorySummarizer: async () => ({
          summary: "There were multiple possible recent proposals."
        }),
        confirmedMutationRecoverer: async () => ({
          outcome: "needs_clarification",
          recoveredText: null,
          reason: "I have two recent proposals in view. Which one do you want me to apply?",
          userReplyMessage: "I have two recent proposals in view. Which one do you want me to apply?"
        }),
        turnRouter: async () => ({
          route: "confirmed_mutation",
          reason: "This looks like a confirmation but the target is ambiguous.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "confirmed_mutation",
      processing: {
        outcome: "conversation_replied",
        reply: "I have two recent proposals in view. Which one do you want me to apply?"
      }
    });
    expect(planner).not.toHaveBeenCalled();
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Applying that"
    });
    expect(editTelegramMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "999",
        messageId: 88,
        text: "I have two recent proposals in view. Which one do you want me to apply?"
      })
    );
  });

  it("keeps conversation turns non-writing", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    vi.useFakeTimers();

    const setNow = (value: string) => {
      vi.setSystemTime(new Date(value));
    };

    try {
      setNow("2026-03-16T16:00:00.000Z");
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:39",
        payload: {
          update_id: 39
        },
        rawText: "Earlier user one",
        normalizedText: "Earlier user one"
      });
      setNow("2026-03-16T16:01:00.000Z");
      await recordOutgoingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_followup_message",
        idempotencyKey: "telegram:followup:route-1",
        payload: {
          chatId: "999",
          text: "Earlier assistant one",
          attempts: 0
        },
        retryState: "sending"
      });
      await updateOutgoingTelegramMessage({
        idempotencyKey: "telegram:followup:route-1",
        payload: {
          chatId: "999",
          text: "Earlier assistant one",
          attempts: 1
        },
        retryState: "sent"
      });
      setNow("2026-03-16T16:02:00.000Z");
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:40",
        payload: {
          update_id: 40
        },
        rawText: "Earlier user two",
        normalizedText: "Earlier user two"
      });
      setNow("2026-03-16T16:03:00.000Z");
      await recordOutgoingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_followup_message",
        idempotencyKey: "telegram:followup:route-2",
        payload: {
          chatId: "999",
          text: "Failed assistant turn",
          attempts: 0
        },
        retryState: "sending"
      });
      await updateOutgoingTelegramMessage({
        idempotencyKey: "telegram:followup:route-2",
        payload: {
          chatId: "999",
          text: "Failed assistant turn",
          attempts: 1
        },
        retryState: "failed"
      });
      setNow("2026-03-16T16:04:00.000Z");
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:41",
        payload: {
          update_id: 41
        },
        rawText: "Earlier user three",
        normalizedText: "Earlier user three"
      });
      setNow("2026-03-16T16:05:00.000Z");
      await recordOutgoingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_followup_message",
        idempotencyKey: "telegram:followup:route-3",
        payload: {
          chatId: "999",
          text: "Earlier assistant two",
          attempts: 0
        },
        retryState: "sending"
      });
      await updateOutgoingTelegramMessage({
        idempotencyKey: "telegram:followup:route-3",
        payload: {
          chatId: "999",
          text: "Earlier assistant two",
          attempts: 1
        },
        retryState: "sent"
      });
      setNow("2026-03-16T16:06:00.000Z");
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:42",
        payload: {
          update_id: 42
        },
        rawText: "Earlier user four",
        normalizedText: "Earlier user four"
      });
      const conversationMemorySummarizer = vi.fn(async () => ({
        summary: "The user wants weekly prioritization help."
      }));
      const conversationResponder = vi.fn(async () => ({
        reply: "Let's sort the week by deadline and energy first."
      }));

      setNow("2026-03-16T16:07:00.000Z");
      const response = await handleTelegramWebhook(
        buildRequest({
          update_id: 47,
          message: {
            message_id: 12,
            date: 1_700_000_005,
            text: "How should I prioritize this week?",
            chat: {
              id: 999,
              type: "private"
            },
            from: {
              id: 123,
              is_bot: false,
              first_name: "Max",
              last_name: "Lin"
            }
          }
        }),
        {
          store: getDefaultInboxProcessingStore(),
          primeProcessingStore: seedInboxItemForProcessingTests,
          conversationMemorySummarizer,
          conversationResponder,
          turnRouter: async () => ({
            route: "conversation",
            reason: "Planning dialogue request.",
            writesAllowed: false
          })
        }
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        accepted: true,
        turnRoute: "conversation",
        processing: {
          outcome: "conversation_replied",
          reply: "Let's sort the week by deadline and energy first."
        },
        outboundDelivery: {
          status: "edited",
          attempts: 1
        }
      });
      expect(listIncomingBotEventsForTests()).toHaveLength(5);
      expect(listInboxItemsForTests()).toHaveLength(5);
      expect(listPlannerRunsForTests()).toHaveLength(0);
      expect(listTasksForTests()).toHaveLength(0);
      expect(listScheduleBlocksForTests()).toHaveLength(0);
      expect(listOutgoingBotEventsForTests()).toHaveLength(4);
      expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
      expect(conversationMemorySummarizer).toHaveBeenCalledWith({
        recentTurns: [
          {
            role: "assistant",
            text: "Earlier assistant one",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user two",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user three",
            createdAt: expect.any(String)
          },
          {
            role: "assistant",
            text: "Earlier assistant two",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user four",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "How should I prioritize this week?",
            createdAt: expect.any(String)
          }
        ]
      });
      expect(conversationResponder).toHaveBeenCalledWith({
        route: "conversation",
        normalizedText: "How should I prioritize this week?",
        recentTurns: [
          {
            role: "assistant",
            text: "Earlier assistant one",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user two",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user three",
            createdAt: expect.any(String)
          },
          {
            role: "assistant",
            text: "Earlier assistant two",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user four",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "How should I prioritize this week?",
            createdAt: expect.any(String)
          }
        ],
        memorySummary: "The user wants weekly prioritization help."
      });
      expect(sendTelegramMessageMock).toHaveBeenCalledWith({
        chatId: "999",
        text: "Thinking"
      });
      expect(editTelegramMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "999",
          messageId: 88,
          text: "Let's sort the week by deadline and energy first."
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps conversation_then_mutation turns non-writing on the first slice", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const conversationResponder = vi.fn(async () => ({
      reply: "We can explore tomorrow morning options first, then I can make the change after you confirm."
    }));

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 48,
        message: {
          message_id: 13,
          date: 1_700_000_006,
          text: "Could we move it to tomorrow morning?",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        conversationMemorySummarizer: async () => ({
          summary: "The user is discussing a possible move to tomorrow morning."
        }),
        conversationResponder,
        turnRouter: async () => ({
          route: "conversation_then_mutation",
          reason: "Mixed turn should discuss first.",
          writesAllowed: false
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "conversation_then_mutation",
      processing: {
        outcome: "conversation_replied",
        reply: "We can explore tomorrow morning options first, then I can make the change after you confirm."
      },
      outboundDelivery: {
        status: "edited",
        attempts: 1
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(conversationResponder).toHaveBeenCalledWith({
      route: "conversation_then_mutation",
      normalizedText: "Could we move it to tomorrow morning?",
      recentTurns: [
        {
          role: "user",
          text: "Could we move it to tomorrow morning?",
          createdAt: expect.any(String)
        }
      ],
      memorySummary: "The user is discussing a possible move to tomorrow morning."
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Thinking"
    });
    expect(editTelegramMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "999",
        messageId: 88,
        text: "We can explore tomorrow morning options first, then I can make the change after you confirm."
      })
    );
  });

  it("falls back to recent turns when summary generation fails", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const conversationResponder = vi.fn(async () => ({
      reply: "From our recent exchange, it sounds like you want to keep talking through it first."
    }));

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 49,
        message: {
          message_id: 14,
          date: 1_700_000_007,
          text: "Should we talk this through first?",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        conversationMemorySummarizer: async () => {
          throw new Error("summary unavailable");
        },
        conversationResponder,
        turnRouter: async () => ({
          route: "conversation",
          reason: "Discussion turn.",
          writesAllowed: false
        })
      }
    );

    expect(response.status).toBe(200);
    expect(conversationResponder).toHaveBeenCalledWith({
      route: "conversation",
      normalizedText: "Should we talk this through first?",
      recentTurns: [
        {
          role: "user",
          text: "Should we talk this through first?",
          createdAt: expect.any(String)
        }
      ],
      memorySummary: null
    });
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Thinking"
    });
  });

  it("keeps write-adjacent conversation replies hedged instead of making hard system claims", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 50,
        message: {
          message_id: 15,
          date: 1_700_000_008,
          text: "Did you already create that?",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        conversationMemorySummarizer: async () => ({
          summary: "The recent exchange seems to be about a dentist reminder."
        }),
        conversationResponder: async () => ({
          reply: "From our recent exchange, it sounds like you mean the dentist reminder, but I am not treating that as confirmed state."
        }),
        turnRouter: async () => ({
          route: "conversation",
          reason: "Write-adjacent question still needs cautious conversational handling.",
          writesAllowed: false
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "conversation",
      processing: {
        outcome: "conversation_replied",
        reply: "From our recent exchange, it sounds like you mean the dentist reminder, but I am not treating that as confirmed state."
      }
    });
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Thinking"
    });
    expect(editTelegramMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "999",
        messageId: 88,
        text:
          "From our recent exchange, it sounds like you mean the dentist reminder, but I am not treating that as confirmed state."
      })
    );
  });

  it("retries once when Telegram follow-up delivery fails before succeeding", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    sendTelegramMessageMock
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockResolvedValue({
        ok: true,
        result: {
          message_id: 89,
          date: 1_700_000_001,
          chat: {
            id: "999",
            type: "private"
          },
          text: "Captured and scheduled Review launch checklist."
        }
      });

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 43,
        message: {
          message_id: 8,
          date: 1_700_000_001,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      outboundDelivery: {
        status: "edited",
        attempts: 2
      }
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2);
    expect(editTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
  });

  it("accepts the webhook when both follow-up delivery attempts fail", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    sendTelegramMessageMock.mockRejectedValue(new Error("telegram unavailable"));

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 44,
        message: {
          message_id: 9,
          date: 1_700_000_002,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      processing: {
        outcome: "planned"
      },
      outboundDelivery: {
        status: "failed",
        attempts: 2,
        error: "telegram unavailable"
      }
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(4);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(listOutgoingBotEventsForTests()[0]?.retryState).toBe("failed");
  });

  it("skips Telegram delivery when the follow-up idempotency key is already reserved", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const deliveryStore = {
      reserveOutgoingIfAbsent: async () => ({
        status: "duplicate" as const
      }),
      updateOutgoing: async () => {
        throw new Error("should not update duplicate outgoing delivery");
      }
    };

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 45,
        message: {
          message_id: 10,
          date: 1_700_000_003,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        calendar: getDefaultCalendarAdapter(),
        deliveryStore,
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      outboundDelivery: {
        status: "duplicate",
        attempts: 0
      }
    });
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("short-circuits duplicate webhook deliveries before downstream processing", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const dependencies = {
      store: getDefaultInboxProcessingStore(),
      calendar: getDefaultCalendarAdapter(),
      primeProcessingStore: seedInboxItemForProcessingTests
    };

    const firstResponse = await handleTelegramWebhook(
      buildRequest({
        update_id: 42,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      dependencies
    );

    const duplicateResponse = await handleTelegramWebhook(
      buildRequest({
        update_id: 42,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      dependencies
    );

    expect(firstResponse.status).toBe(200);
    const duplicateBody = duplicateResponse.body;

    expect(duplicateBody).toMatchObject({
      accepted: true,
      duplicate: true,
      idempotencyKey: "telegram:webhook:update:42"
    });
    expect(duplicateBody).not.toHaveProperty("ingestion");
    expect(duplicateBody).not.toHaveProperty("inboxItem");
    expect(duplicateBody).not.toHaveProperty("processing");
    expect(duplicateBody).not.toHaveProperty("outboundDelivery");
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not attempt bot-event recording for malformed Telegram payloads", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest({
        message: {
          text: "missing update id"
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(400);
    await expect(Promise.resolve(response.body)).resolves.toMatchObject({
      accepted: false,
      error: "invalid_telegram_update"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listInboxItemsForTests()).toHaveLength(0);
    expect(listOutgoingBotEventsForTests()).toHaveLength(0);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });
});
