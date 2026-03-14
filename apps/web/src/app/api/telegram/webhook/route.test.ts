import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultInboxProcessingStore,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  resetInboxProcessingStoreForTests,
  resetIncomingTelegramIngressStoreForTests,
  seedInboxItemForProcessingTests
} from "@atlas/db";

import { handleTelegramWebhook } from "@/lib/server/telegram-webhook";

vi.mock("@atlas/integrations", () => ({
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
  })
}));

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
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
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
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
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
  });
});
