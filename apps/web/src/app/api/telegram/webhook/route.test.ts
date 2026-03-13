import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  resetIncomingTelegramIngressStoreForTests
} from "@atlas/db";

import { POST } from "./route";

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
});

describe("telegram webhook route", () => {
  it("rejects requests with the wrong Telegram webhook secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await POST(
      buildRequest(
        {
          update_id: 1
        },
        "wrong-secret"
      )
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      error: "invalid_webhook_secret"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listInboxItemsForTests()).toHaveLength(0);
  });

  it("normalizes a Telegram text message and hands it to app services", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await POST(
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
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
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
        confidence: 1,
        linkedTaskIds: []
      },
      processing: {
        accepted: true
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
  });

  it("short-circuits duplicate webhook deliveries before downstream processing", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const firstResponse = await POST(
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
      })
    );

    const duplicateResponse = await POST(
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
      })
    );

    expect(firstResponse.status).toBe(200);
    const duplicateBody = await duplicateResponse.json();

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

    const response = await POST(
      buildRequest({
        message: {
          text: "missing update id"
        }
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      error: "invalid_telegram_update"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listInboxItemsForTests()).toHaveLength(0);
  });
});
