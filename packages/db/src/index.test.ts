import { describe, expect, it } from "vitest";

import {
  getRepositoryHealth,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  recordIncomingTelegramMessageIfNew,
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
});
