import { describe, expect, it } from "vitest";

import {
  getRepositoryHealth,
  listIncomingBotEventsForTests,
  recordIncomingBotEventIfNew,
  resetIncomingBotEventStoreForTests
} from "./index";

describe("db package", () => {
  it("exposes a repository placeholder", () => {
    expect(getRepositoryHealth().status).toBe("unconfigured");
  });

  it("records a first-seen incoming bot event", async () => {
    resetIncomingBotEventStoreForTests();

    const result = await recordIncomingBotEventIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:42",
      payload: {
        update_id: 42
      }
    });

    expect(result.status).toBe("recorded");
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
  });

  it("returns duplicate for repeated idempotency keys", async () => {
    resetIncomingBotEventStoreForTests();

    await recordIncomingBotEventIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:42",
      payload: {
        update_id: 42
      }
    });

    const duplicate = await recordIncomingBotEventIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:42",
      payload: {
        update_id: 42
      }
    });

    expect(duplicate).toEqual({
      status: "duplicate"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
  });

  it("keeps distinct Telegram update ids as separate ingress events", async () => {
    resetIncomingBotEventStoreForTests();

    await recordIncomingBotEventIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:42",
      payload: {
        update_id: 42
      }
    });

    await recordIncomingBotEventIfNew({
      userId: "123",
      eventType: "telegram_message",
      idempotencyKey: "telegram:webhook:update:43",
      payload: {
        update_id: 43
      }
    });

    expect(listIncomingBotEventsForTests()).toHaveLength(2);
  });
});
