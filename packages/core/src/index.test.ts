import { describe, expect, it } from "vitest";

import {
  buildScheduleProposal,
  buildTelegramWebhookIdempotencyKey,
  getConfig,
  normalizeTelegramText,
  normalizeTelegramUpdate,
  processInboxItem,
  userProfileSchema
} from "./index";

describe("core package", () => {
  it("validates a user profile with a bounded breakdown level", () => {
    const result = userProfileSchema.safeParse({
      userId: "user_1",
      timezone: "America/Los_Angeles",
      workdayStartHour: 9,
      workdayEndHour: 17,
      deepWorkWindows: [],
      blackoutWindows: [],
      focusBlockMinutes: 50,
      reminderStyle: "gentle",
      breakdownLevel: 5
    });

    expect(result.success).toBe(true);
  });

  it("uses deterministic defaults for local development", () => {
    const config = getConfig();
    expect(config.TELEGRAM_WEBHOOK_SECRET).toBe("dev-webhook-secret");
  });

  it("returns a typed placeholder extraction", async () => {
    const result = await processInboxItem({ rawText: "Call the doctor tomorrow." });
    expect(result.accepted).toBe(true);
    expect(result.extraction?.tasks).toHaveLength(1);
  });

  it("returns an empty valid schedule proposal for the skeleton", async () => {
    const result = await buildScheduleProposal({
      userId: "user_1",
      openActions: [],
      userProfile: {
        userId: "user_1",
        timezone: "America/Los_Angeles",
        workdayStartHour: 9,
        workdayEndHour: 17,
        deepWorkWindows: [],
        blackoutWindows: [],
        focusBlockMinutes: 50,
        reminderStyle: "gentle",
        breakdownLevel: 5
      },
      existingBlocks: []
    });

    expect(result.inserts).toEqual([]);
    expect(result.moves).toEqual([]);
  });

  it("normalizes Telegram text into a planner-friendly string", () => {
    expect(normalizeTelegramText("  Call   the doctor \n tomorrow  ")).toBe(
      "Call the doctor tomorrow"
    );
  });

  it("derives a stable Telegram webhook idempotency key from update id", () => {
    expect(buildTelegramWebhookIdempotencyKey(42)).toBe("telegram:webhook:update:42");
  });

  it("extracts normalized Telegram message metadata from a webhook update", () => {
    const normalized = normalizeTelegramUpdate({
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
    });

    expect(normalized).toMatchObject({
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
    });
  });
});
