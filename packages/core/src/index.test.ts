import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  buildDefaultUserProfile,
  buildInboxPlanningContext,
  buildScheduleAdjustment,
  buildScheduleProposal,
  buildTelegramWebhookIdempotencyKey,
  getConfig,
  inboxPlanningOutputSchema,
  normalizeTelegramText,
  normalizeTelegramUpdate,
  processInboxItem,
  resolveScheduleBlockReference,
  resolveTaskReference,
  scheduleBlockSchema,
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

  it("requires explicit config values", () => {
    expect(() => getConfig({})).toThrow(ZodError);
  });

  it("accepts explicit config overrides", () => {
    const config = getConfig({
      DATABASE_URL: "postgres://atlas:atlas@localhost:5432/atlas",
      OPENAI_API_KEY: "test-openai-key",
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret"
    });

    expect(config).toMatchObject({
      DATABASE_URL: "postgres://atlas:atlas@localhost:5432/atlas",
      OPENAI_API_KEY: "test-openai-key",
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret"
    });
  });

  it("builds planning context aliases for existing tasks and schedule blocks", () => {
    const context = buildInboxPlanningContext({
      inboxItem: {
        id: "inbox-1",
        userId: "123",
        sourceEventId: "event-1",
        rawText: "move it to 3pm",
        normalizedText: "move it to 3pm",
        processingStatus: "received",
        linkedTaskIds: []
      },
      userProfile: buildDefaultUserProfile("123"),
      tasks: [
        {
          id: "task-1",
          userId: "123",
          sourceInboxItemId: "inbox-0",
          title: "Review launch checklist",
          status: "open",
          priority: "medium",
          urgency: "medium"
        }
      ],
      scheduleBlocks: [
        {
          id: "block-1",
          userId: "123",
          taskId: "task-1",
          startAt: "2026-03-13T17:00:00.000Z",
          endAt: "2026-03-13T18:00:00.000Z",
          confidence: 0.8,
          reason: "Existing slot",
          rescheduleCount: 0,
          externalCalendarId: null
        }
      ]
    });

    expect(context.tasks[0]?.alias).toBe("existing_task_1");
    expect(context.scheduleBlocks[0]?.alias).toBe("schedule_block_1");
  });

  it("resolves symbolic task and schedule block aliases", () => {
    const context = buildInboxPlanningContext({
      inboxItem: {
        id: "inbox-1",
        userId: "123",
        sourceEventId: "event-1",
        rawText: "move it to 3pm",
        normalizedText: "move it to 3pm",
        processingStatus: "received",
        linkedTaskIds: []
      },
      userProfile: buildDefaultUserProfile("123"),
      tasks: [
        {
          id: "task-1",
          userId: "123",
          sourceInboxItemId: "inbox-0",
          title: "Review launch checklist",
          status: "open",
          priority: "medium",
          urgency: "medium"
        }
      ],
      scheduleBlocks: [
        {
          id: "block-1",
          userId: "123",
          taskId: "task-1",
          startAt: "2026-03-13T17:00:00.000Z",
          endAt: "2026-03-13T18:00:00.000Z",
          confidence: 0.8,
          reason: "Existing slot",
          rescheduleCount: 0,
          externalCalendarId: null
        }
      ]
    });

    expect(
      resolveTaskReference(context, {
        kind: "existing_task",
        alias: "existing_task_1"
      })?.id
    ).toBe("task-1");
    expect(
      resolveScheduleBlockReference(context, {
        alias: "schedule_block_1"
      })?.id
    ).toBe("block-1");
  });

  it("accepts contract-shaped planning outputs", async () => {
    const result = await processInboxItem({
      confidence: 0.9,
      summary: "Create and schedule a task.",
      actions: [
        {
          type: "create_task",
          alias: "new_task_1",
          title: "Submit taxes",
          priority: "medium",
          urgency: "high"
        },
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "created_task",
            alias: "new_task_1"
          },
          scheduleConstraint: {
            dayOffset: 1,
            explicitHour: 15,
            minute: 0,
            preferredWindow: null,
            sourceText: "tomorrow at 3pm"
          },
          reason: "The user requested tomorrow at 3pm."
        }
      ]
    });

    expect(result.actions).toHaveLength(2);
  });

  it("rejects malformed structured outputs at the contract boundary", () => {
    const result = inboxPlanningOutputSchema.safeParse({
      confidence: 1.5,
      summary: "Bad result",
      actions: []
    });

    expect(result.success).toBe(false);
  });

  it("builds a valid schedule proposal for new tasks", async () => {
    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        {
          id: "task-1",
          userId: "user_1",
          sourceInboxItemId: "inbox-1",
          title: "Review launch checklist",
          status: "open",
          priority: "medium",
          urgency: "medium"
        }
      ],
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
      existingBlocks: [],
      now: "2026-03-13T08:00:00.000Z",
      scheduleConstraint: {
        dayOffset: 1,
        explicitHour: 15,
        minute: 0,
        preferredWindow: null,
        sourceText: "tomorrow at 3pm"
      }
    });

    expect(result.inserts).toHaveLength(1);
    expect(result.inserts[0]?.startAt).toContain("T15:00:00.000Z");
  });

  it("builds schedule adjustments from structured move requests", () => {
    const result = buildScheduleAdjustment({
      block: scheduleBlockSchema.parse({
        id: "block-1",
        userId: "user-1",
        taskId: "task-1",
        startAt: "2026-03-13T17:00:00.000Z",
        endAt: "2026-03-13T18:00:00.000Z",
        confidence: 0.8,
        reason: "Existing slot",
        rescheduleCount: 0
      }),
      userProfile: buildDefaultUserProfile("user-1"),
      scheduleConstraint: {
        dayOffset: 0,
        explicitHour: 15,
        minute: 0,
        preferredWindow: null,
        sourceText: "at 3pm"
      },
      existingBlocks: []
    });

    expect(result.newStartAt).toContain("T15:00:00.000Z");
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
