import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultInboxProcessingStore,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  listOutgoingBotEventsForTests,
  resetInboxProcessingStoreForTests,
  resetIncomingTelegramIngressStoreForTests,
  seedInboxItemForProcessingTests
} from "@atlas/db";
import { resetCalendarAdapterForTests } from "@atlas/integrations";

import { handleTelegramWebhook } from "@/lib/server/telegram-webhook";

const { sendTelegramMessageMock, routeTurnWithResponsesMock } = vi.hoisted(() => ({
  sendTelegramMessageMock: vi.fn(),
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
            dayOffset: 0,
            explicitHour: 9,
            minute: 0,
            preferredWindow: null,
            sourceText: "default next slot"
          },
          reason: "Schedule the new task in the next slot."
        }
      ]
    }),
    routeTurnWithResponses: routeTurnWithResponsesMock,
    sendTelegramMessage: sendTelegramMessageMock
  };
});

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET
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

afterEach(() => {
  restoreEnv("DATABASE_URL");
  restoreEnv("OPENAI_API_KEY");
  restoreEnv("TELEGRAM_BOT_TOKEN");
  restoreEnv("TELEGRAM_WEBHOOK_SECRET");
});

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://atlas:atlas@localhost:5432/atlas";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
  resetCalendarAdapterForTests();
  sendTelegramMessageMock.mockReset();
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
  resetIncomingTelegramIngressStoreForTests();
  resetInboxProcessingStoreForTests();
});

describe("telegram webhook route", () => {
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
        status: "sent",
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
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Captured and scheduled Review launch checklist."
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
        status: "sent",
        attempts: 1
      }
    });
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("keeps conversation turns non-writing", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

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
        conversationResponder: async () => ({
          reply: "Let's sort the week by deadline and energy first."
        }),
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
        status: "sent",
        attempts: 1
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Let's sort the week by deadline and energy first."
    });
  });

  it("keeps conversation_then_mutation turns non-writing on the first slice", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

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
        conversationResponder: async () => ({
          reply: "We can explore tomorrow morning options first, then I can make the change after you confirm."
        }),
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
        status: "sent",
        attempts: 1
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "We can explore tomorrow morning options first, then I can make the change after you confirm."
    });
  });

  it("retries once when Telegram follow-up delivery fails before succeeding", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    sendTelegramMessageMock
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockResolvedValueOnce({
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
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      outboundDelivery: {
        status: "sent",
        attempts: 2
      }
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2);
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
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2);
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
