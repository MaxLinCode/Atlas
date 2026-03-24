import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  buildCapturedTask,
  buildBusyScheduleBlocks,
  buildDefaultUserProfile,
  buildGoogleCalendarLinkToken,
  buildInboxPlanningContext,
  buildScheduleAdjustment,
  buildScheduleBlocksFromTasks,
  buildScheduleProposal,
  buildTelegramFollowUpIdempotencyKey,
  buildTelegramWebhookIdempotencyKey,
  confirmedMutationRecoveryOutputSchema,
  conversationStateSnapshotSchema,
  detectTaskCalendarDrift,
  getConfig,
  getGoogleCalendarOAuthConfig,
  getTelegramAllowedUserIds,
  verifyGoogleCalendarLinkToken,
  inboxPlanningOutputSchema,
  isTelegramUserAllowed,
  isTaskFollowupDue,
  isTaskFollowupReminderDue,
  normalizeTelegramText,
  normalizeTelegramUpdate,
  processInboxItem,
  createEmptyDiscourseState,
  resolveScheduleBlockReference,
  resolveTaskReference,
  scheduleBlockSchema,
  taskSchema,
  turnRoutingOutputSchema,
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
      APP_BASE_URL: "https://atlas.example.com",
      OPENAI_API_KEY: "test-openai-key",
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://example.com/api/google-calendar/oauth/callback",
      GOOGLE_LINK_TOKEN_SECRET: "google-link-secret",
      GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      CRON_SECRET: "cron-secret"
    });

    expect(config).toMatchObject({
      DATABASE_URL: "postgres://atlas:atlas@localhost:5432/atlas",
      APP_BASE_URL: "https://atlas.example.com",
      OPENAI_API_KEY: "test-openai-key",
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://example.com/api/google-calendar/oauth/callback",
      GOOGLE_LINK_TOKEN_SECRET: "google-link-secret",
      GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      CRON_SECRET: "cron-secret"
    });
  });

  it("requires TELEGRAM_ALLOWED_USER_IDS in config", () => {
    expect(() =>
      getConfig({
        DATABASE_URL: "postgres://atlas:atlas@localhost:5432/atlas",
        APP_BASE_URL: "https://atlas.example.com",
        OPENAI_API_KEY: "test-openai-key",
        TELEGRAM_BOT_TOKEN: "test-telegram-token",
        TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
        TELEGRAM_ALLOWED_USER_IDS: ""
      })
    ).toThrow(/TELEGRAM_ALLOWED_USER_IDS is required/);
  });

  it("parses Telegram allowlisted user ids from config", () => {
    expect(
      getTelegramAllowedUserIds({
        TELEGRAM_ALLOWED_USER_IDS: "123, 456 ,789"
      })
    ).toEqual(new Set(["123", "456", "789"]));
  });

  it("requires explicit Google Calendar OAuth config values", () => {
    expect(() =>
      getGoogleCalendarOAuthConfig({
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "google-client-secret",
        GOOGLE_OAUTH_REDIRECT_URI: "https://example.com/api/google-calendar/oauth/callback"
      })
    ).toThrow();
  });

  it("fails closed for an empty Telegram allowlist and blocks unknown users otherwise", () => {
    expect(isTelegramUserAllowed("123", new Set())).toBe(false);
    expect(isTelegramUserAllowed("123", new Set(["456"]))).toBe(false);
    expect(isTelegramUserAllowed("123", new Set(["123"]))).toBe(true);
  });

  it("builds stable Telegram idempotency keys", () => {
    expect(buildTelegramFollowUpIdempotencyKey("inbox-1")).toBe(
      "telegram:followup:inbox-item:inbox-1"
    );
    expect(buildTelegramWebhookIdempotencyKey(42)).toBe("telegram:webhook:update:42");
  });

  it("builds and verifies signed Google Calendar link tokens", () => {
    const token = buildGoogleCalendarLinkToken({
      userId: "123",
      handoffId: "8c92af58-5f9a-4da3-9244-dd018395afb6",
      expiresAt: "2026-03-20T17:00:00.000Z",
      secret: "webhook-secret"
    });

    expect(
      verifyGoogleCalendarLinkToken({
        token,
        secret: "webhook-secret",
        now: "2026-03-20T16:00:00.000Z"
      })
    ).toMatchObject({
      userId: "123",
      handoffId: "8c92af58-5f9a-4da3-9244-dd018395afb6"
    });
    expect(
      verifyGoogleCalendarLinkToken({
        token,
        secret: "wrong-secret",
        now: "2026-03-20T16:00:00.000Z"
      })
    ).toBeNull();
  });

  it("builds the default captured task shape in core", () => {
    expect(
      buildCapturedTask({
        userId: "123",
        inboxItemId: "inbox-1",
        title: "Review launch checklist",
        priority: "medium",
        urgency: "high"
      })
    ).toEqual({
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
      urgency: "high"
    });
  });

  it("accepts scheduled task live state with external calendar linkage", () => {
    const result = taskSchema.safeParse({
      id: "task-1",
      userId: "123",
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-2",
      title: "Review launch checklist",
      lifecycleState: "awaiting_followup",
      externalCalendarEventId: "event-1",
      externalCalendarId: "primary",
      scheduledStartAt: "2026-03-15T16:00:00.000Z",
      scheduledEndAt: "2026-03-15T17:00:00.000Z",
      calendarSyncStatus: "in_sync",
      calendarSyncUpdatedAt: "2026-03-15T17:05:00.000Z",
      rescheduleCount: 2,
      lastFollowupAt: "2026-03-15T17:05:00.000Z",
      completedAt: null,
      archivedAt: null,
      priority: "medium",
      urgency: "high"
    });

    expect(result.success).toBe(true);
  });

  it("rejects unscheduled tasks that retain current commitment fields", () => {
    const result = taskSchema.safeParse({
      id: "task-1",
      userId: "123",
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-2",
      title: "Review launch checklist",
      lifecycleState: "pending_schedule",
      externalCalendarEventId: "event-1",
      externalCalendarId: "primary",
      scheduledStartAt: "2026-03-15T16:00:00.000Z",
      scheduledEndAt: "2026-03-15T17:00:00.000Z",
      calendarSyncStatus: "in_sync",
      calendarSyncUpdatedAt: null,
      rescheduleCount: 0,
      lastFollowupAt: null,
      completedAt: null,
      archivedAt: null,
      priority: "medium",
      urgency: "high"
    });

    expect(result.success).toBe(false);
  });

  it("builds planning context aliases from task-backed current commitments", () => {
    const task = taskSchema.parse({
      id: "task-1",
      userId: "123",
      sourceInboxItemId: "inbox-0",
      lastInboxItemId: "inbox-0",
      title: "Review launch checklist",
      lifecycleState: "scheduled",
      externalCalendarEventId: "event-1",
      externalCalendarId: "primary",
      scheduledStartAt: "2026-03-13T17:00:00.000Z",
      scheduledEndAt: "2026-03-13T18:00:00.000Z",
      calendarSyncStatus: "in_sync",
      calendarSyncUpdatedAt: null,
      rescheduleCount: 0,
      lastFollowupAt: null,
      completedAt: null,
      archivedAt: null,
      priority: "medium",
      urgency: "medium"
    });
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
      tasks: [task],
      referenceTime: "2026-03-14T16:00:00.000Z"
    });

    expect(context.tasks[0]?.alias).toBe("existing_task_1");
    expect(context.scheduleBlocks[0]?.alias).toBe("schedule_block_1");
    expect(resolveTaskReference(context, { kind: "existing_task", alias: "existing_task_1" })?.id).toBe("task-1");
    expect(resolveScheduleBlockReference(context, { alias: "schedule_block_1" })?.id).toBe("event-1");
    expect(buildScheduleBlocksFromTasks([task])).toHaveLength(1);
  });

  it("builds busy blocks from external calendar busy periods", () => {
    expect(
      buildBusyScheduleBlocks({
        userId: "123",
        periods: [
          {
            startAt: "2026-03-13T19:00:00.000Z",
            endAt: "2026-03-13T20:00:00.000Z",
            externalCalendarId: "primary"
          }
        ]
      })
    ).toMatchObject([
      {
        userId: "123",
        startAt: "2026-03-13T19:00:00.000Z",
        endAt: "2026-03-13T20:00:00.000Z",
        externalCalendarId: "primary"
      }
    ]);
  });

  it("detects task drift when the linked Google event changed", () => {
    const task = taskSchema.parse({
      id: "task-1",
      userId: "123",
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-1",
      title: "Review launch checklist",
      lifecycleState: "scheduled",
      externalCalendarEventId: "event-1",
      externalCalendarId: "primary",
      scheduledStartAt: "2026-03-13T17:00:00.000Z",
      scheduledEndAt: "2026-03-13T18:00:00.000Z",
      calendarSyncStatus: "in_sync",
      calendarSyncUpdatedAt: null,
      rescheduleCount: 0,
      lastFollowupAt: null,
      completedAt: null,
      archivedAt: null,
      priority: "medium",
      urgency: "medium"
    });

    expect(
      detectTaskCalendarDrift({
        task,
        liveEvent: {
          externalCalendarEventId: "event-1",
          externalCalendarId: "primary",
          scheduledStartAt: "2026-03-13T18:00:00.000Z",
          scheduledEndAt: "2026-03-13T19:00:00.000Z"
        }
      })
    ).toMatchObject({
      taskId: "task-1",
      reason: "calendar_changed"
    });
  });

  it("does not build busy schedule blocks from out-of-sync task projections", () => {
    const task = taskSchema.parse({
      id: "task-1",
      userId: "123",
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-1",
      title: "Review launch checklist",
      lifecycleState: "scheduled",
      externalCalendarEventId: "event-1",
      externalCalendarId: "primary",
      scheduledStartAt: "2026-03-13T17:00:00.000Z",
      scheduledEndAt: "2026-03-13T18:00:00.000Z",
      calendarSyncStatus: "out_of_sync",
      calendarSyncUpdatedAt: "2026-03-13T18:05:00.000Z",
      rescheduleCount: 0,
      lastFollowupAt: null,
      completedAt: null,
      archivedAt: null,
      priority: "medium",
      urgency: "medium"
    });

    expect(buildScheduleBlocksFromTasks([task])).toEqual([]);
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
            dayReference: "tomorrow",
            weekday: null,
            weekOffset: null,
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

  it("accepts completion actions for existing tasks", async () => {
    const result = await processInboxItem({
      confidence: 0.9,
      summary: "Mark the journaling session as done.",
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
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: "complete_task"
    });
  });

  it("rejects malformed structured outputs at the contract boundary", () => {
    const result = inboxPlanningOutputSchema.safeParse({
      confidence: 1.5,
      summary: "Bad result",
      actions: []
    });

    expect(result.success).toBe(false);
  });

  it("accepts confirmed_mutation as a valid turn route and parses recovery outputs", () => {
    const routeResult = turnRoutingOutputSchema.safeParse({
      route: "confirmed_mutation",
      reason: "The user confirmed one recent concrete proposal."
    });
    const recoveryResult = confirmedMutationRecoveryOutputSchema.safeParse({
      outcome: "recovered",
      recoveredText: "Schedule the dentist reminder at 3pm.",
      reason: "The user confirmed the recent concrete proposal.",
      userReplyMessage: "Got it - I've added the dentist reminder to your schedule for today at 3pm."
    });

    expect(routeResult.success).toBe(true);
    expect(recoveryResult.success).toBe(true);
  });

  it("accepts null schedule constraints for delegated slot choice", () => {
    const result = inboxPlanningOutputSchema.safeParse({
      confidence: 0.82,
      summary: "Schedule the task using the next reasonable opening.",
      actions: [
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "existing_task",
            alias: "existing_task_1"
          },
          scheduleConstraint: null,
          reason: "The user asked Atlas to choose the time."
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("accepts needs_clarification recovery outputs", () => {
    const clarificationResult = confirmedMutationRecoveryOutputSchema.safeParse({
      outcome: "needs_clarification",
      recoveredText: null,
      reason: "I found two recent proposals for the user. User request is ambiguous.",
      userReplyMessage: "I found two recent proposals. Which one do you want me to apply?"
    });

    expect(clarificationResult.success).toBe(true);
  });

  it("builds a valid schedule proposal for pending tasks", async () => {
    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        taskSchema.parse({
          id: "task-1",
          userId: "user_1",
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
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        })
      ],
      userProfile: buildDefaultUserProfile("user_1"),
      existingBlocks: [],
      referenceTime: "2026-03-13T08:00:00.000Z",
      scheduleConstraint: {
        dayReference: "tomorrow",
        weekday: null,
        weekOffset: null,
        relativeMinutes: null,
        explicitHour: 15,
        minute: 0,
        preferredWindow: null,
        sourceText: "tomorrow at 3pm"
      }
    });

    expect(result.inserts[0]?.startAt).toBe("2026-03-14T22:00:00.000Z");
  });

  it("accepts relative-minute schedule constraints", () => {
    const result = inboxPlanningOutputSchema.safeParse({
      confidence: 0.9,
      summary: "Schedule car maintenance in 15 minutes.",
      actions: [
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "existing_task",
            alias: "existing_task_1"
          },
          scheduleConstraint: {
            dayReference: null,
            weekday: null,
            weekOffset: null,
            relativeMinutes: 15,
            explicitHour: null,
            minute: null,
            preferredWindow: null,
            sourceText: "in like 15 min"
          },
          reason: "The user asked for a relative start time."
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("builds schedule proposals from relative-minute requests", async () => {
    const profile = buildDefaultUserProfile("user_1");
    profile.timezone = "America/Los_Angeles";

    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        taskSchema.parse({
          id: "task-1",
          userId: "user_1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Car maintenance",
          lifecycleState: "pending_schedule",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        })
      ],
      userProfile: profile,
      existingBlocks: [],
      referenceTime: "2026-03-20T01:02:00.000Z",
      scheduleConstraint: {
        dayReference: null,
        weekday: null,
        weekOffset: null,
        relativeMinutes: 15,
        explicitHour: null,
        minute: null,
        preferredWindow: null,
        sourceText: "in like 15 min"
      }
    });

    expect(result.inserts[0]?.startAt).toBe("2026-03-20T01:17:00.000Z");
  });

  it("builds schedule proposals from explicit time blocks without falling back to the default duration", async () => {
    const profile = buildDefaultUserProfile("user_1");
    profile.timezone = "America/Los_Angeles";

    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        taskSchema.parse({
          id: "task-1",
          userId: "user_1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Quick check-in",
          lifecycleState: "pending_schedule",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        })
      ],
      userProfile: profile,
      existingBlocks: [],
      referenceTime: "2026-03-20T16:00:00.000Z",
      scheduleConstraint: {
        dayReference: "today",
        weekday: null,
        weekOffset: null,
        relativeMinutes: null,
        explicitHour: 11,
        minute: 5,
        endExplicitHour: 11,
        endMinute: 9,
        preferredWindow: null,
        sourceText: "today from 11:05 to 11:09"
      }
    });

    expect(result.inserts[0]?.startAt).toBe("2026-03-20T18:05:00.000Z");
    expect(result.inserts[0]?.endAt).toBe("2026-03-20T18:09:00.000Z");
  });

  it("uses the explicit block duration when checking conflicts for schedule proposals", async () => {
    const profile = buildDefaultUserProfile("user_1");
    profile.timezone = "America/Los_Angeles";

    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        taskSchema.parse({
          id: "task-1",
          userId: "user_1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Quick check-in",
          lifecycleState: "pending_schedule",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        })
      ],
      userProfile: profile,
      existingBlocks: [
        scheduleBlockSchema.parse({
          id: "block-1",
          userId: "user_1",
          taskId: "task-a",
          startAt: "2026-03-20T18:00:00.000Z",
          endAt: "2026-03-20T18:05:00.000Z",
          confidence: 0.8,
          reason: "Existing block",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }),
        scheduleBlockSchema.parse({
          id: "block-2",
          userId: "user_1",
          taskId: "task-b",
          startAt: "2026-03-20T18:09:00.000Z",
          endAt: "2026-03-20T19:00:00.000Z",
          confidence: 0.8,
          reason: "Existing block",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        })
      ],
      referenceTime: "2026-03-20T16:00:00.000Z",
      scheduleConstraint: {
        dayReference: "today",
        weekday: null,
        weekOffset: null,
        relativeMinutes: null,
        explicitHour: 11,
        minute: 5,
        endExplicitHour: 11,
        endMinute: 9,
        preferredWindow: null,
        sourceText: "today from 11:05 to 11:09"
      }
    });

    expect(result.inserts[0]?.startAt).toBe("2026-03-20T18:05:00.000Z");
    expect(result.inserts[0]?.endAt).toBe("2026-03-20T18:09:00.000Z");
  });

  it("builds schedule adjustments from structured move requests", () => {
    const result = buildScheduleAdjustment({
      block: scheduleBlockSchema.parse({
        id: "event-1",
        userId: "user-1",
        taskId: "task-1",
        startAt: "2026-03-13T17:00:00.000Z",
        endAt: "2026-03-13T18:00:00.000Z",
        confidence: 0.8,
        reason: "Existing slot",
        rescheduleCount: 0,
        externalCalendarId: "primary"
      }),
      userProfile: buildDefaultUserProfile("user-1"),
      scheduleConstraint: {
        dayReference: null,
        weekday: null,
        weekOffset: null,
        relativeMinutes: null,
        explicitHour: 15,
        minute: 0,
        preferredWindow: null,
        sourceText: "at 3pm"
      },
      existingBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    });

    expect(result.newStartAt).toBe("2026-03-13T22:00:00.000Z");
  });

  it("keeps move requests on the existing block day when only the time changes", () => {
    const result = buildScheduleAdjustment({
      block: scheduleBlockSchema.parse({
        id: "event-1",
        userId: "user-1",
        taskId: "task-1",
        startAt: "2026-03-20T16:00:00.000Z",
        endAt: "2026-03-20T17:00:00.000Z",
        confidence: 0.8,
        reason: "Existing slot",
        rescheduleCount: 0,
        externalCalendarId: "primary"
      }),
      userProfile: buildDefaultUserProfile("user-1"),
      scheduleConstraint: {
        dayReference: null,
        weekday: null,
        weekOffset: null,
        relativeMinutes: null,
        explicitHour: 10,
        minute: 0,
        preferredWindow: null,
        sourceText: "10am"
      },
      existingBlocks: [],
      referenceTime: "2026-03-19T16:00:00.000Z"
    });

    expect(result.newStartAt).toBe("2026-03-20T17:00:00.000Z");
  });

  it("preserves explicit move-block durations from the structured constraint", () => {
    const result = buildScheduleAdjustment({
      block: scheduleBlockSchema.parse({
        id: "event-1",
        userId: "user-1",
        taskId: "task-1",
        startAt: "2026-03-20T18:00:00.000Z",
        endAt: "2026-03-20T19:00:00.000Z",
        confidence: 0.8,
        reason: "Existing slot",
        rescheduleCount: 0,
        externalCalendarId: "primary"
      }),
      userProfile: buildDefaultUserProfile("user-1"),
      scheduleConstraint: {
        dayReference: null,
        weekday: null,
        weekOffset: null,
        relativeMinutes: null,
        explicitHour: 11,
        minute: 5,
        endExplicitHour: 11,
        endMinute: 9,
        preferredWindow: null,
        sourceText: "11:05 to 11:09"
      },
      existingBlocks: [],
      referenceTime: "2026-03-20T16:00:00.000Z"
    });

    expect(result.newStartAt).toBe("2026-03-20T18:05:00.000Z");
    expect(result.newEndAt).toBe("2026-03-20T18:09:00.000Z");
  });

  it("interprets preferred-window scheduling in the user's timezone near UTC day boundaries", async () => {
    const profile = buildDefaultUserProfile("user_1");
    profile.timezone = "America/Los_Angeles";

    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        taskSchema.parse({
          id: "task-1",
          userId: "user_1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Plan quarterly review",
          lifecycleState: "pending_schedule",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        })
      ],
      userProfile: profile,
      existingBlocks: [],
      referenceTime: "2026-03-19T06:00:00.000Z",
      scheduleConstraint: {
        dayReference: "weekday",
        weekday: "friday",
        weekOffset: 0,
        relativeMinutes: null,
        explicitHour: null,
        minute: null,
        preferredWindow: "morning",
        sourceText: "Friday morning"
      }
    });

    expect(result.inserts[0]?.startAt).toBe("2026-03-20T16:00:00.000Z");
  });

  it("resolves weekday scheduling from the reference time in the user's timezone", async () => {
    const profile = buildDefaultUserProfile("user_1");
    profile.timezone = "America/Los_Angeles";

    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        taskSchema.parse({
          id: "task-1",
          userId: "user_1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Car maintenance",
          lifecycleState: "pending_schedule",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        })
      ],
      userProfile: profile,
      existingBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z",
      scheduleConstraint: {
        dayReference: "weekday",
        weekday: "friday",
        weekOffset: 0,
        relativeMinutes: null,
        explicitHour: 10,
        minute: 0,
        preferredWindow: null,
        sourceText: "Friday at 10am"
      }
    });

    expect(result.inserts[0]?.startAt).toBe("2026-03-20T17:00:00.000Z");
  });

  it("rejects weekday scheduling without a weekday value", () => {
    const result = inboxPlanningOutputSchema.safeParse({
      confidence: 0.9,
      summary: "Bad schedule constraint",
      actions: [
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "existing_task",
            alias: "existing_task_1"
          },
          scheduleConstraint: {
            dayReference: "weekday",
            weekday: null,
            weekOffset: null,
            relativeMinutes: null,
            explicitHour: 10,
            minute: 0,
            preferredWindow: null,
            sourceText: "Friday at 10am"
          },
          reason: "Invalid weekday constraint."
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it("resolves next weekday scheduling with a week offset", async () => {
    const profile = buildDefaultUserProfile("user_1");
    profile.timezone = "America/Los_Angeles";

    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        taskSchema.parse({
          id: "task-1",
          userId: "user_1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Plan review",
          lifecycleState: "pending_schedule",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        })
      ],
      userProfile: profile,
      existingBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z",
      scheduleConstraint: {
        dayReference: "weekday",
        weekday: "friday",
        weekOffset: 1,
        relativeMinutes: null,
        explicitHour: 10,
        minute: 0,
        preferredWindow: null,
        sourceText: "next Friday at 10am"
      }
    });

    expect(result.inserts[0]?.startAt).toBe("2026-03-27T17:00:00.000Z");
  });

  it("resolves repeated next weekday scheduling with larger week offsets", async () => {
    const profile = buildDefaultUserProfile("user_1");
    profile.timezone = "America/Los_Angeles";

    const result = await buildScheduleProposal({
      userId: "user_1",
      openTasks: [
        taskSchema.parse({
          id: "task-1",
          userId: "user_1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Plan review",
          lifecycleState: "pending_schedule",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        })
      ],
      userProfile: profile,
      existingBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z",
      scheduleConstraint: {
        dayReference: "weekday",
        weekday: "friday",
        weekOffset: 2,
        relativeMinutes: null,
        explicitHour: 10,
        minute: 0,
        preferredWindow: null,
        sourceText: "next next Friday at 10am"
      }
    });

    expect(result.inserts[0]?.startAt).toBe("2026-04-03T17:00:00.000Z");
  });

  it("marks scheduled tasks as follow-up due only after the end time", () => {
    const task = taskSchema.parse({
      id: "task-1",
      userId: "123",
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-1",
      title: "Review launch checklist",
      lifecycleState: "scheduled",
      externalCalendarEventId: "event-1",
      externalCalendarId: "primary",
      scheduledStartAt: "2026-03-15T16:00:00.000Z",
      scheduledEndAt: "2026-03-15T17:00:00.000Z",
      calendarSyncStatus: "in_sync",
      calendarSyncUpdatedAt: null,
      rescheduleCount: 0,
      lastFollowupAt: null,
      followupReminderSentAt: null,
      completedAt: null,
      archivedAt: null,
      priority: "medium",
      urgency: "medium"
    });

    expect(isTaskFollowupDue(task, "2026-03-15T16:59:00.000Z")).toBe(false);
    expect(isTaskFollowupDue(task, "2026-03-15T17:00:00.000Z")).toBe(true);
  });

  it("marks awaiting followup tasks as reminder due only once after two hours", () => {
    const task = taskSchema.parse({
      id: "task-1",
      userId: "123",
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-1",
      title: "Review launch checklist",
      lifecycleState: "awaiting_followup",
      externalCalendarEventId: "event-1",
      externalCalendarId: "primary",
      scheduledStartAt: "2026-03-15T16:00:00.000Z",
      scheduledEndAt: "2026-03-15T17:00:00.000Z",
      calendarSyncStatus: "in_sync",
      calendarSyncUpdatedAt: null,
      rescheduleCount: 0,
      lastFollowupAt: "2026-03-15T17:00:00.000Z",
      followupReminderSentAt: null,
      completedAt: null,
      archivedAt: null,
      priority: "medium",
      urgency: "medium"
    });

    expect(isTaskFollowupReminderDue(task, "2026-03-15T18:59:00.000Z")).toBe(false);
    expect(isTaskFollowupReminderDue(task, "2026-03-15T19:00:00.000Z")).toBe(true);
    expect(
      isTaskFollowupReminderDue({ ...task, followupReminderSentAt: "2026-03-15T19:00:00.000Z" }, "2026-03-15T21:00:00.000Z")
    ).toBe(false);
  });

  it("parses explicit conversation state with entity registry and discourse state", () => {
    const parsed = conversationStateSnapshotSchema.parse({
      conversation: {
        id: "conversation-1",
        userId: "123",
        title: "Telegram planning thread",
        summaryText: "The user is discussing a move for the dentist reminder.",
        mode: "conversation_then_mutation",
        createdAt: "2026-03-20T16:00:00.000Z",
        updatedAt: "2026-03-20T16:05:00.000Z"
      },
      transcript: [
        {
          role: "user",
          text: "Could we move it after lunch?",
          createdAt: "2026-03-20T16:05:00.000Z"
        }
      ],
      entityRegistry: [
        {
          id: "entity-1",
          conversationId: "conversation-1",
          kind: "proposal_option",
          label: "Move the dentist reminder after lunch.",
          status: "active",
          createdAt: "2026-03-20T16:04:00.000Z",
          updatedAt: "2026-03-20T16:04:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "It sounds like you want to move the dentist reminder after lunch.",
            slotSnapshot: {}
          }
        }
      ],
      discourseState: createEmptyDiscourseState()
    });

    expect(parsed.entityRegistry[0]?.kind).toBe("proposal_option");
    expect(parsed.discourseState?.last_user_mentioned_entity_ids).toEqual([]);
    expect(parsed.discourseState?.mode).toBe("planning");
  });

  it("normalizes Telegram text and webhook metadata", () => {
    expect(normalizeTelegramText("  Call   the doctor \n tomorrow  ")).toBe("Call the doctor tomorrow");

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
