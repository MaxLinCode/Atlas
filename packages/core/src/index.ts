import { randomUUID } from "node:crypto";
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";
import {
  conversationDiscourseStateSchema,
  resolvedSlotsSchema,
  writeContractSchema
} from "./discourse-state";

export * from "./ambiguity";
export * from "./commit-policy";
export * from "./discourse-state";
export * from "./proposal-rules";
export * from "./slot-normalizer";
export * from "./telegram";
export * from "./write-contract";

const postgresConnectionStringSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}, "DATABASE_URL must be a Postgres connection string.");

const envSchema = z.object({
  DATABASE_URL: postgresConnectionStringSchema,
  APP_BASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_LINK_TOKEN_SECRET: z.string().min(1).optional(),
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional()
}).superRefine((config, ctx) => {
  if (!config.TELEGRAM_ALLOWED_USER_IDS?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "TELEGRAM_ALLOWED_USER_IDS is required.",
      path: ["TELEGRAM_ALLOWED_USER_IDS"]
    });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

export type GoogleCalendarOAuthConfig = {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_OAUTH_REDIRECT_URI: string;
};

export type GoogleCalendarSecurityConfig = {
  GOOGLE_LINK_TOKEN_SECRET: string;
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: string;
};

export function getConfig(overrides: Partial<Record<keyof AppConfig, string>> = {}) {
  return envSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    APP_BASE_URL: process.env.APP_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    GOOGLE_LINK_TOKEN_SECRET: process.env.GOOGLE_LINK_TOKEN_SECRET,
    GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    ...overrides
  });
}

export function getAppBaseUrl(config: Pick<AppConfig, "APP_BASE_URL"> = getConfig()) {
  return config.APP_BASE_URL;
}

export function getGoogleCalendarOAuthConfig(
  overrides: Partial<Record<keyof GoogleCalendarOAuthConfig, string>> = {}
) {
  return z
    .object({
      GOOGLE_CLIENT_ID: z.string().min(1),
      GOOGLE_CLIENT_SECRET: z.string().min(1),
      GOOGLE_OAUTH_REDIRECT_URI: z.string().url()
    })
    .parse({
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
      ...overrides
    });
}

export function getGoogleCalendarSecurityConfig(
  overrides: Partial<Record<keyof GoogleCalendarSecurityConfig, string>> = {}
) {
  return z
    .object({
      GOOGLE_LINK_TOKEN_SECRET: z.string().min(1),
      GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: z.string().min(1)
    })
    .parse({
      GOOGLE_LINK_TOKEN_SECRET: process.env.GOOGLE_LINK_TOKEN_SECRET,
      GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY,
      ...overrides
    });
}

export function getTelegramAllowedUserIds(config: Pick<AppConfig, "TELEGRAM_ALLOWED_USER_IDS"> = getConfig()) {
  const rawValue = config.TELEGRAM_ALLOWED_USER_IDS;

  if (!rawValue) {
    return new Set<string>();
  }

  return new Set(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export function buildGoogleCalendarLinkToken(input: {
  userId: string;
  handoffId: string;
  expiresAt: string;
  secret: string;
}) {
  const payload = Buffer.from(JSON.stringify({
    userId: input.userId,
    handoffId: input.handoffId,
    expiresAt: input.expiresAt
  })).toString("base64url");
  const signature = createHmac("sha256", input.secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyGoogleCalendarLinkToken(input: {
  token: string;
  secret: string;
  now?: string;
}) {
  const parts = input.token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [payload, signature] = parts;

  if (!payload || !signature) {
    return null;
  }

  const expected = createHmac("sha256", input.secret).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  let decoded: { userId: string; handoffId: string; expiresAt: string };

  try {
    decoded = z.object({
      userId: z.string().min(1),
      handoffId: z.string().uuid(),
      expiresAt: z.string().datetime()
    }).parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer) ||
    Date.parse(decoded.expiresAt) < Date.parse(input.now ?? new Date().toISOString())
  ) {
    return null;
  }

  return {
    userId: decoded.userId,
    handoffId: decoded.handoffId,
    expiresAt: decoded.expiresAt
  };
}

export function isTelegramUserAllowed(
  telegramUserId: string,
  allowedUserIds: ReadonlySet<string>
) {
  if (allowedUserIds.size === 0) {
    return false;
  }

  return allowedUserIds.has(telegramUserId);
}

export const inboxProcessingStatusSchema = z.enum([
  "received",
  "processing",
  "planned",
  "needs_clarification"
]);

export const inboxItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sourceEventId: z.string().nullable().optional(),
  rawText: z.string(),
  normalizedText: z.string(),
  processingStatus: inboxProcessingStatusSchema,
  linkedTaskIds: z.array(z.string()).default([]),
  createdAt: z.string().datetime().optional()
});

const baseTaskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  sourceInboxItemId: z.string(),
  lastInboxItemId: z.string(),
  lifecycleState: z.enum(["pending_schedule", "scheduled", "awaiting_followup", "done", "archived"]),
  externalCalendarEventId: z.string().nullable().default(null),
  externalCalendarId: z.string().nullable().default(null),
  scheduledStartAt: z.string().datetime().nullable().default(null),
  scheduledEndAt: z.string().datetime().nullable().default(null),
  calendarSyncStatus: z.enum(["in_sync", "out_of_sync"]).default("in_sync"),
  calendarSyncUpdatedAt: z.string().datetime().nullable().default(null),
  rescheduleCount: z.number().int().nonnegative(),
  lastFollowupAt: z.string().datetime().nullable().default(null),
  followupReminderSentAt: z.string().datetime().nullable().default(null),
  completedAt: z.string().datetime().nullable().default(null),
  archivedAt: z.string().datetime().nullable().default(null),
  priority: z.enum(["low", "medium", "high"]),
  urgency: z.enum(["low", "medium", "high"]),
  energyTag: z.enum(["low", "medium", "high"]).optional(),
  createdAt: z.string().datetime().optional()
});

export const taskSchema = baseTaskSchema.superRefine((task, ctx) => {
  const hasCurrentCommitment =
    task.externalCalendarEventId !== null ||
    task.externalCalendarId !== null ||
    task.scheduledStartAt !== null ||
    task.scheduledEndAt !== null;
  const hasCompleteCurrentCommitment =
    task.externalCalendarEventId !== null &&
    task.externalCalendarId !== null &&
    task.scheduledStartAt !== null &&
    task.scheduledEndAt !== null;

  if (task.lifecycleState === "scheduled" || task.lifecycleState === "awaiting_followup") {
    if (!hasCompleteCurrentCommitment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Scheduled tasks must include a complete current calendar commitment."
      });
    }
  } else if (hasCurrentCommitment) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only scheduled or awaiting_followup tasks may retain current calendar commitment fields."
    });
  }

  if (task.lifecycleState === "done" && task.completedAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Done tasks must record completedAt."
    });
  }

  if (task.lifecycleState !== "done" && task.completedAt !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only done tasks may record completedAt."
    });
  }

  if (task.lifecycleState === "archived" && task.archivedAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Archived tasks must record archivedAt."
    });
  }

  if (task.lifecycleState !== "archived" && task.archivedAt !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only archived tasks may record archivedAt."
    });
  }

  if (task.followupReminderSentAt !== null && task.lastFollowupAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "followupReminderSentAt requires lastFollowupAt."
    });
  }
});

export const taskActionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  order: z.number().int().nonnegative(),
  title: z.string(),
  estimatedMinutes: z.number().int().positive(),
  breakdownLevel: z.number().int().min(1).max(10),
  status: z.enum(["open", "scheduled", "done", "stale"])
});

export const scheduleBlockSchema = z.object({
  id: z.string(),
  userId: z.string(),
  taskId: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  rescheduleCount: z.number().int().nonnegative(),
  externalCalendarId: z.string().nullable().default(null)
});

export const calendarBusyPeriodSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  externalCalendarId: z.string().min(1)
});

export const taskCalendarDriftSchema = z.object({
  taskId: z.string(),
  reason: z.enum(["missing_event", "calendar_changed"]),
  expectedStartAt: z.string().datetime().nullable(),
  expectedEndAt: z.string().datetime().nullable(),
  actualStartAt: z.string().datetime().nullable(),
  actualEndAt: z.string().datetime().nullable()
});

export const userProfileSchema = z.object({
  userId: z.string(),
  timezone: z.string(),
  workdayStartHour: z.number().int().min(0).max(23),
  workdayEndHour: z.number().int().min(0).max(23),
  deepWorkWindows: z.array(
    z.object({
      day: z.number().int().min(0).max(6),
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(0).max(23)
    })
  ),
  blackoutWindows: z.array(
    z.object({
      day: z.number().int().min(0).max(6),
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(0).max(23)
    })
  ),
  focusBlockMinutes: z.number().int().positive(),
  reminderStyle: z.enum(["gentle", "direct"]),
  breakdownLevel: z.number().int().min(1).max(10)
});

export const taskCandidateSchema = z.object({
  title: z.string().min(1),
  priority: z.enum(["low", "medium", "high"]),
  urgency: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1)
});

export const weekdaySchema = z.enum([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
]);

export const scheduleConstraintSchema = z.object({
  dayReference: z.enum(["today", "tomorrow", "weekday"]).nullable(),
  weekday: weekdaySchema.nullable(),
  weekOffset: z.number().int().min(0).max(8).nullable(),
  relativeMinutes: z.number().int().positive().max(7 * 24 * 60).nullable().optional(),
  explicitHour: z.number().int().min(0).max(23).nullable(),
  minute: z.number().int().min(0).max(59).nullable().default(null),
  endExplicitHour: z.number().int().min(0).max(23).nullable().optional(),
  endMinute: z.number().int().min(0).max(59).nullable().optional(),
  preferredWindow: z.enum(["morning", "afternoon", "evening"]).nullable(),
  sourceText: z.string().min(1)
}).superRefine((constraint, ctx) => {
  if (constraint.dayReference === "weekday" && constraint.weekday === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "weekday is required when dayReference is 'weekday'.",
      path: ["weekday"]
    });
  }

  if (constraint.dayReference !== "weekday" && constraint.weekday !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "weekday must be null unless dayReference is 'weekday'.",
      path: ["weekday"]
    });
  }

  if (constraint.dayReference === "weekday" && constraint.weekOffset === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "weekOffset is required when dayReference is 'weekday'.",
      path: ["weekOffset"]
    });
  }

  if (constraint.dayReference !== "weekday" && constraint.weekOffset !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "weekOffset must be null unless dayReference is 'weekday'.",
      path: ["weekOffset"]
    });
  }

  if (constraint.relativeMinutes != null) {
    if (
      constraint.dayReference !== null ||
      constraint.weekday !== null ||
      constraint.weekOffset !== null ||
      constraint.explicitHour !== null ||
      constraint.minute !== null ||
      constraint.endExplicitHour != null ||
      constraint.endMinute != null ||
      constraint.preferredWindow !== null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "relativeMinutes cannot be combined with absolute date or time fields.",
        path: ["relativeMinutes"]
      });
    }

    return;
  }

  if (constraint.explicitHour === null && constraint.preferredWindow === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "explicitHour or preferredWindow is required when relativeMinutes is null.",
      path: ["explicitHour"]
    });
  }

  if (constraint.explicitHour !== null && constraint.minute === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minute is required when explicitHour is provided.",
      path: ["minute"]
    });
  }

  if (constraint.explicitHour === null && constraint.endExplicitHour != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "endExplicitHour requires explicitHour.",
      path: ["endExplicitHour"]
    });
  }

  if (constraint.endExplicitHour != null && constraint.endMinute == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "endMinute is required when endExplicitHour is provided.",
      path: ["endMinute"]
    });
  }

  if (constraint.endExplicitHour == null && constraint.endMinute != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "endMinute must be null unless endExplicitHour is provided.",
      path: ["endMinute"]
    });
  }

  if (constraint.explicitHour === null && constraint.preferredWindow === null && constraint.minute !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minute must be null unless explicitHour is provided.",
      path: ["minute"]
    });
  }

  if (constraint.preferredWindow !== null && constraint.endExplicitHour != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "endExplicitHour must be null when preferredWindow is used.",
      path: ["endExplicitHour"]
    });
  }

  if (
    constraint.explicitHour !== null &&
    constraint.minute !== null &&
    constraint.endExplicitHour != null &&
    constraint.endMinute != null
  ) {
    const startMinutes = constraint.explicitHour * 60 + constraint.minute;
    const endMinutes = constraint.endExplicitHour * 60 + constraint.endMinute;

    if (endMinutes <= startMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "end time must be after the start time on the same day.",
        path: ["endExplicitHour"]
      });
    }
  }

});

export const scheduleConstraintResponseFormatSchema = z.object({
  dayReference: z.enum(["today", "tomorrow", "weekday"]).nullable(),
  weekday: weekdaySchema.nullable(),
  weekOffset: z.number().int().min(0).max(8).nullable(),
  relativeMinutes: z.number().int().positive().max(7 * 24 * 60).nullable().optional(),
  explicitHour: z.number().int().min(0).max(23).nullable(),
  minute: z.number().int().min(0).max(59).nullable(),
  endExplicitHour: z.number().int().min(0).max(23).nullable().optional(),
  endMinute: z.number().int().min(0).max(59).nullable().optional(),
  preferredWindow: z.enum(["morning", "afternoon", "evening"]).nullable(),
  sourceText: z.string().min(1)
});

export const taskReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("created_task"),
    alias: z.string().min(1)
  }),
  z.object({
    kind: z.literal("existing_task"),
    alias: z.string().min(1)
  })
]);

export const scheduleBlockReferenceSchema = z.object({
  alias: z.string().min(1)
});

export const createTaskPlanningActionSchema = z.object({
  type: z.literal("create_task"),
  alias: z.string().min(1),
  title: z.string().min(1),
  priority: z.enum(["low", "medium", "high"]),
  urgency: z.enum(["low", "medium", "high"])
});

export const createScheduleBlockPlanningActionSchema = z.object({
  type: z.literal("create_schedule_block"),
  taskRef: taskReferenceSchema,
  scheduleConstraint: scheduleConstraintSchema.nullable(),
  reason: z.string().min(1)
});

export const createScheduleBlockPlanningActionResponseFormatSchema = z.object({
  type: z.literal("create_schedule_block"),
  taskRef: z.object({
    kind: z.enum(["created_task", "existing_task"]),
    alias: z.string().min(1)
  }).nullable().optional(),
  scheduleConstraint: scheduleConstraintResponseFormatSchema.nullable().optional(),
  reason: z.string().min(1).nullable().optional()
});

export const moveScheduleBlockPlanningActionSchema = z.object({
  type: z.literal("move_schedule_block"),
  blockRef: scheduleBlockReferenceSchema,
  scheduleConstraint: scheduleConstraintSchema.nullable(),
  reason: z.string().min(1)
});

export const moveScheduleBlockPlanningActionResponseFormatSchema = z.object({
  type: z.literal("move_schedule_block"),
  blockRef: z.object({
    alias: z.string().min(1)
  }).nullable().optional(),
  scheduleConstraint: scheduleConstraintResponseFormatSchema.nullable().optional(),
  reason: z.string().min(1).nullable().optional()
});

export const completeTaskPlanningActionSchema = z.object({
  type: z.literal("complete_task"),
  taskRef: taskReferenceSchema,
  reason: z.string().min(1)
});

export const clarifyPlanningActionSchema = z.object({
  type: z.literal("clarify"),
  reason: z.string().min(1)
});

export const planningActionSchema = z.discriminatedUnion("type", [
  createTaskPlanningActionSchema,
  createScheduleBlockPlanningActionSchema,
  moveScheduleBlockPlanningActionSchema,
  completeTaskPlanningActionSchema,
  clarifyPlanningActionSchema
]);

export const planningActionResponseFormatSchema = z.object({
  type: z.enum([
    "create_task",
    "create_schedule_block",
    "move_schedule_block",
    "complete_task",
    "clarify"
  ]),
  alias: z.string().min(1).nullable().optional(),
  title: z.string().min(1).nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).nullable().optional(),
  urgency: z.enum(["low", "medium", "high"]).nullable().optional(),
  taskRef: z.object({
    kind: z.enum(["created_task", "existing_task"]),
    alias: z.string().min(1)
  }).nullable().optional(),
  blockRef: z.object({
    alias: z.string().min(1)
  }).nullable().optional(),
  scheduleConstraint: scheduleConstraintResponseFormatSchema.nullable().optional(),
  reason: z.string().min(1).nullable().optional()
});

export const inboxPlanningOutputSchema = z.object({
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  actions: z.array(planningActionSchema).min(1)
});

export const inboxPlanningResponseFormatSchema = z.object({
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  actions: z.array(planningActionResponseFormatSchema).min(1)
});

export const inboxPlanningTaskContextSchema = z.object({
  alias: z.string().min(1),
  task: taskSchema
});

export const inboxPlanningScheduleBlockContextSchema = z.object({
  alias: z.string().min(1),
  scheduleBlock: scheduleBlockSchema,
  taskTitle: z.string().min(1)
});

export const inboxPlanningContextSchema = z.object({
  inboxItem: inboxItemSchema,
  userProfile: userProfileSchema,
  tasks: z.array(inboxPlanningTaskContextSchema),
  scheduleBlocks: z.array(inboxPlanningScheduleBlockContextSchema),
  referenceTime: z.string().datetime()
});

export const conversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  createdAt: z.string().datetime()
});

export const conversationRecordModeSchema = z.enum([
  "conversation",
  "mutation",
  "conversation_then_mutation",
  "confirmed_mutation"
]);

const conversationEntityBaseSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["active", "presented", "confirmed", "resolved", "superseded"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const conversationTaskEntitySchema = conversationEntityBaseSchema.extend({
  kind: z.literal("task"),
  data: z.object({
    taskId: z.string().min(1),
    title: z.string().min(1),
    lifecycleState: z.enum(["pending_schedule", "scheduled", "awaiting_followup", "done", "archived"]),
    scheduledStartAt: z.string().datetime().nullable(),
    scheduledEndAt: z.string().datetime().nullable()
  })
});

export const conversationProposalOptionEntitySchema = conversationEntityBaseSchema.extend({
  kind: z.literal("proposal_option"),
  data: z.object({
    route: z.enum(["conversation", "conversation_then_mutation"]),
    replyText: z.string().min(1),
    policyAction: z
      .enum(["reply_only", "ask_clarification", "present_proposal", "execute_mutation", "recover_and_execute"])
      .optional(),
    targetEntityId: z.string().min(1).nullable().optional(),
    mutationInputSource: z.enum(["direct_user_turn", "recovered_proposal"]).nullable().optional(),
    confirmationRequired: z.boolean().optional(),
    originatingTurnText: z.string().min(1).nullable().optional(),
    missingSlots: z.array(z.string().min(1)).optional()
  })
});

export const conversationScheduledBlockEntitySchema = conversationEntityBaseSchema.extend({
  kind: z.literal("scheduled_block"),
  data: z.object({
    blockId: z.string().min(1),
    taskId: z.string().min(1),
    title: z.string().min(1),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    externalCalendarId: z.string().nullable()
  })
});

export const conversationClarificationEntitySchema = conversationEntityBaseSchema.extend({
  kind: z.literal("clarification"),
  data: z.object({
    prompt: z.string().min(1),
    reason: z.string().min(1).nullable(),
    open: z.boolean()
  })
});

export const conversationReminderEntitySchema = conversationEntityBaseSchema.extend({
  kind: z.literal("reminder"),
  data: z.object({
    taskId: z.string().min(1),
    title: z.string().min(1),
    reminderKind: z.enum(["initial", "reminder"]),
    number: z.number().int().positive().nullable()
  })
});

export const conversationEntitySchema = z.discriminatedUnion("kind", [
  conversationTaskEntitySchema,
  conversationProposalOptionEntitySchema,
  conversationScheduledBlockEntitySchema,
  conversationClarificationEntitySchema,
  conversationReminderEntitySchema
]);

export const conversationRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  title: z.string().nullable(),
  summaryText: z.string().nullable(),
  mode: conversationRecordModeSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const conversationStateSnapshotSchema = z.object({
  conversation: conversationRecordSchema,
  transcript: z.array(conversationTurnSchema),
  entityRegistry: z.array(conversationEntitySchema),
  discourseState: conversationDiscourseStateSchema.nullable()
});

export const turnRouteSchema = z.enum([
  "conversation",
  "mutation",
  "conversation_then_mutation",
  "confirmed_mutation"
]);

export const turnRoutingInputSchema = z.object({
  rawText: z.string().min(1),
  normalizedText: z.string().min(1),
  recentTurns: z.array(conversationTurnSchema),
  summaryText: z.string().nullable().optional(),
  entityRegistry: z.array(conversationEntitySchema).optional().default([]),
  discourseState: conversationDiscourseStateSchema.nullable().optional()
});

export const turnRoutingOutputSchema = z.object({
  route: turnRouteSchema,
  reason: z.string().min(1)
});

export const turnInterpretationTypeSchema = z.enum([
  "informational",
  "planning_request",
  "edit_request",
  "clarification_answer",
  "confirmation",
  "follow_up_reply",
  "unknown"
]);

export const turnAmbiguitySchema = z.enum(["none", "low", "high"]);

export const turnInterpretationSchema = z.object({
  turnType: turnInterpretationTypeSchema,
  confidence: z.number().min(0).max(1),
  resolvedEntityIds: z.array(z.string().min(1)).default([]),
  resolvedProposalId: z.string().min(1).optional(),
  ambiguity: turnAmbiguitySchema,
  ambiguityReason: z.string().min(1).optional(),
  missingSlots: z.array(z.string().min(1)).optional(),
  notes: z.array(z.string().min(1)).optional()
});

export const turnPolicyActionSchema = z.enum([
  "reply_only",
  "ask_clarification",
  "present_proposal",
  "execute_mutation",
  "recover_and_execute"
]);

export const turnPolicyDecisionSchema = z.object({
  action: turnPolicyActionSchema,
  reason: z.string().min(1),
  requiresWrite: z.boolean(),
  requiresConfirmation: z.boolean(),
  useMutationPipeline: z.boolean(),
  targetEntityId: z.string().min(1).optional(),
  targetProposalId: z.string().min(1).optional(),
  mutationInputSource: z.enum(["direct_user_turn", "recovered_proposal"]).optional(),
  clarificationSlots: z.array(z.string().min(1)).optional(),
  committedSlots: resolvedSlotsSchema.optional().default({}),
  resolvedContract: writeContractSchema.optional()
});

export const routedTurnSchema = z.object({
  interpretation: turnInterpretationSchema,
  policy: turnPolicyDecisionSchema
});

const slotKeySchema = z.enum(["day", "time", "duration", "target"]);

const slotConfidenceSchema = z.object({
  day: z.number().nullable().optional(),
  time: z.number().nullable().optional(),
  duration: z.number().nullable().optional(),
  target: z.number().nullable().optional()
});

export const rawSlotExtractionSchema = z.object({
  time: z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).nullable(),
  day: z.object({
    kind: z.enum(["relative", "weekday", "absolute"]),
    value: z.string()
  }).nullable(),
  duration: z.object({ minutes: z.number().int().min(0) }).nullable(),
  target: z.object({ entityId: z.string() }).nullable(),
  confidence: slotConfidenceSchema,
  unresolvable: z.array(slotKeySchema)
});

export const slotExtractorInputSchema = z.object({
  currentTurnText: z.string(),
  pendingSlots: z.array(slotKeySchema),
  priorResolvedSlots: resolvedSlotsSchema,
  conversationContext: z.string().optional()
});

export const slotExtractorOutputSchema = z.object({
  extractedValues: resolvedSlotsSchema.partial(),
  confidence: slotConfidenceSchema,
  unresolvable: z.array(slotKeySchema)
});

export const turnClassifierInputSchema = z.object({
  normalizedText: z.string().min(1),
  discourseState: conversationDiscourseStateSchema.nullable(),
  entityRegistry: z.array(conversationEntitySchema).optional().default([])
});

export const turnClassifierResponseSchema = z.object({
  turnType: turnInterpretationTypeSchema,
  confidence: z.number(),
  reasoning: z.string().nullable()
});

export const turnClassifierOutputSchema = z.object({
  turnType: turnInterpretationTypeSchema,
  confidence: z.number().min(0).max(1),
  resolvedEntityIds: z.array(z.string().min(1)).default([]),
  resolvedProposalId: z.string().min(1).optional()
});

export const confirmedMutationRecoveryInputSchema = z.object({
  rawText: z.string().min(1),
  normalizedText: z.string().min(1),
  recentTurns: z.array(conversationTurnSchema),
  memorySummary: z.string().nullable(),
  entityRegistry: z.array(conversationEntitySchema).optional().default([]),
  discourseState: conversationDiscourseStateSchema.nullable().optional()
});

export const confirmedMutationRecoveryResponseFormatSchema = z.object({
  outcome: z.enum(["recovered", "needs_clarification"]),
  recoveredText: z.string().nullable(),
  reason: z.string().min(1),
  userReplyMessage: z.string().min(1)
});

export const confirmedMutationRecoveryOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("recovered"),
    recoveredText: z.string().min(1),
    reason: z.string().min(1),
    userReplyMessage: z.string().min(1)
  }),
  z.object({
    outcome: z.literal("needs_clarification"),
    recoveredText: z.null(),
    reason: z.string().min(1),
    userReplyMessage: z.string().min(1)
  })
]);

export const scheduleProposalInputSchema = z.object({
  userId: z.string(),
  openTasks: z.array(taskSchema),
  userProfile: userProfileSchema,
  existingBlocks: z.array(scheduleBlockSchema),
  scheduleConstraint: scheduleConstraintSchema.nullable().optional(),
  referenceTime: z.string().datetime()
});

export const scheduleProposalOutputSchema = z.object({
  inserts: z.array(scheduleBlockSchema),
  moves: z.array(
    z.object({
      blockId: z.string(),
      taskId: z.string(),
      newStartAt: z.string(),
      newEndAt: z.string(),
      reason: z.string()
    })
  )
});

export type InboxItem = z.infer<typeof inboxItemSchema>;
export type ScheduleConstraint = z.infer<typeof scheduleConstraintSchema>;
export type Weekday = z.infer<typeof weekdaySchema>;
export type ScheduleProposalInput = z.infer<typeof scheduleProposalInputSchema>;
export type ScheduleProposalOutput = z.infer<typeof scheduleProposalOutputSchema>;
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskAction = z.infer<typeof taskActionSchema>;
export type TaskCandidate = z.infer<typeof taskCandidateSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type CalendarBusyPeriod = z.infer<typeof calendarBusyPeriodSchema>;
export type TaskCalendarDrift = z.infer<typeof taskCalendarDriftSchema>;
export type PlanningAction = z.infer<typeof planningActionSchema>;
export type InboxPlanningOutput = z.infer<typeof inboxPlanningOutputSchema>;
export type TaskReference = z.infer<typeof taskReferenceSchema>;
export type ScheduleBlockReference = z.infer<typeof scheduleBlockReferenceSchema>;
export type InboxPlanningContext = z.infer<typeof inboxPlanningContextSchema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type ConversationEntity = z.infer<typeof conversationEntitySchema>;
export type ConversationRecordMode = z.infer<typeof conversationRecordModeSchema>;
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;
export type ConversationStateSnapshot = z.infer<typeof conversationStateSnapshotSchema>;
export type TurnRoute = z.infer<typeof turnRouteSchema>;
export type TurnRoutingInput = z.input<typeof turnRoutingInputSchema>;
export type TurnRoutingOutput = z.infer<typeof turnRoutingOutputSchema>;
export type TurnInterpretationType = z.infer<typeof turnInterpretationTypeSchema>;
export type TurnAmbiguity = z.infer<typeof turnAmbiguitySchema>;
export type TurnInterpretation = z.infer<typeof turnInterpretationSchema>;
export type TurnPolicyAction = z.infer<typeof turnPolicyActionSchema>;
export type TurnPolicyDecision = z.infer<typeof turnPolicyDecisionSchema>;
export type RoutedTurn = z.infer<typeof routedTurnSchema>;
export type SlotKey = z.infer<typeof slotKeySchema>;
export type RawSlotExtraction = z.infer<typeof rawSlotExtractionSchema>;
export type SlotExtractorInput = z.infer<typeof slotExtractorInputSchema>;
export type SlotExtractorOutput = z.infer<typeof slotExtractorOutputSchema>;
export type TurnClassifierInput = z.input<typeof turnClassifierInputSchema>;
export type TurnClassifierResponse = z.infer<typeof turnClassifierResponseSchema>;
export type TurnClassifierOutput = z.infer<typeof turnClassifierOutputSchema>;
export type ConfirmedMutationRecoveryInput = z.input<typeof confirmedMutationRecoveryInputSchema>;
export type ConfirmedMutationRecoveryOutput = z.infer<typeof confirmedMutationRecoveryOutputSchema>;
export type CapturedTaskInput = {
  userId: string;
  inboxItemId: string;
  title: string;
  priority: Task["priority"];
  urgency: Task["urgency"];
};

export const isConfirmedMutationRecovered = (
  output: ConfirmedMutationRecoveryOutput
): output is ConfirmedMutationRecoveryOutput & {
  outcome: "recovered";
  recoveredText: string;
} => {
  return (
    output.outcome === "recovered" &&
    typeof output.recoveredText === "string"
  );
};

const DEFAULT_USER_PROFILE: Omit<UserProfile, "userId"> = {
  timezone: "America/Los_Angeles",
  workdayStartHour: 9,
  workdayEndHour: 17,
  deepWorkWindows: [],
  blackoutWindows: [],
  focusBlockMinutes: 60,
  reminderStyle: "direct",
  breakdownLevel: 1
};

export function buildDefaultUserProfile(userId: string): UserProfile {
  return userProfileSchema.parse({
    userId,
    ...DEFAULT_USER_PROFILE
  });
}

export function buildCapturedTask(input: CapturedTaskInput): Omit<Task, "id" | "createdAt"> {
  return baseTaskSchema.omit({
    id: true,
    createdAt: true
  }).parse({
    userId: input.userId,
    sourceInboxItemId: input.inboxItemId,
    lastInboxItemId: input.inboxItemId,
    title: input.title,
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
    priority: input.priority,
    urgency: input.urgency
  });
}

export function buildInboxPlanningContext(input: {
  inboxItem: InboxItem;
  userProfile: UserProfile;
  tasks: Task[];
  scheduleBlocks?: ScheduleBlock[];
  referenceTime: string;
}): InboxPlanningContext {
  const scheduleBlocks = input.scheduleBlocks ?? buildScheduleBlocksFromTasks(input.tasks);

  return inboxPlanningContextSchema.parse({
    inboxItem: input.inboxItem,
    userProfile: input.userProfile,
    tasks: input.tasks.map((task, index) => ({
      alias: `existing_task_${index + 1}`,
      task
    })),
    scheduleBlocks: scheduleBlocks.map((scheduleBlock, index) => ({
      alias: `schedule_block_${index + 1}`,
      scheduleBlock,
      taskTitle: input.tasks.find((task) => task.id === scheduleBlock.taskId)?.title ?? "Scheduled task"
    })),
    referenceTime: input.referenceTime
  });
}

export function resolveTaskReference(
  context: InboxPlanningContext,
  reference: TaskReference,
  createdTaskAliases: Map<string, Task> = new Map()
) {
  if (reference.kind === "created_task") {
    return createdTaskAliases.get(reference.alias) ?? null;
  }

  const match = context.tasks.find((item) => item.alias === reference.alias);
  return match?.task ?? null;
}

export function resolveScheduleBlockReference(
  context: InboxPlanningContext,
  reference: ScheduleBlockReference
) {
  const match = context.scheduleBlocks.find((item) => item.alias === reference.alias);
  return match?.scheduleBlock ?? null;
}

export async function buildScheduleProposal(input: ScheduleProposalInput) {
  const parsed = scheduleProposalInputSchema.parse(input);
  const profile = parsed.userProfile;
  const referenceTime = new Date(parsed.referenceTime);

  const inserts = parsed.openTasks.map((task, index) =>
    scheduleBlockSchema.parse({
      id: randomUUID(),
      userId: task.userId,
      taskId: task.id,
      startAt: computeStartAt({
        referenceTime,
        profile,
        existingBlocks: parsed.existingBlocks,
        constraint: parsed.scheduleConstraint ?? null,
        slotOffset: index
      }).toISOString(),
      endAt: computeEndAt({
        referenceTime,
        profile,
        existingBlocks: parsed.existingBlocks,
        constraint: parsed.scheduleConstraint ?? null,
        slotOffset: index
      }).toISOString(),
      confidence: parsed.scheduleConstraint ? 0.84 : 0.72,
      reason: parsed.scheduleConstraint
        ? `Scheduled from model timing request: ${parsed.scheduleConstraint.sourceText}`
        : "Scheduled from model-driven task capture using default planning rules.",
      rescheduleCount: 0,
      externalCalendarId: null
    })
  );

  return scheduleProposalOutputSchema.parse({
    inserts,
    moves: []
  });
}

export function buildScheduleAdjustment(input: {
  block: ScheduleBlock;
  userProfile: UserProfile;
  scheduleConstraint: ScheduleConstraint | null;
  existingBlocks: ScheduleBlock[];
  referenceTime: string;
}) {
  const referenceTime = new Date(input.referenceTime);
  const existingDurationMinutes = Math.round((Date.parse(input.block.endAt) - Date.parse(input.block.startAt)) / 60000);
  const durationMinutes = computeConstraintDurationMinutes(input.scheduleConstraint) ?? (existingDurationMinutes || 60);
  const startAt = computeStartAt({
    referenceTime,
    profile: input.userProfile,
    existingBlocks: input.existingBlocks.filter((block) => block.id !== input.block.id),
    constraint: input.scheduleConstraint,
    constraintBaseDate: new Date(input.block.startAt),
    slotOffset: 0
  });
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

  return {
    blockId: input.block.id,
    taskId: input.block.taskId,
    newStartAt: startAt.toISOString(),
    newEndAt: endAt.toISOString(),
    reason: input.scheduleConstraint
      ? `Moved from model timing request: ${input.scheduleConstraint.sourceText}`
      : "Moved using default rescheduling rules."
  };
}

type ComputeStartAtInput = {
  referenceTime: Date;
  profile: UserProfile;
  existingBlocks: ScheduleBlock[];
  constraint: ScheduleConstraint | null;
  constraintBaseDate?: Date;
  slotOffset: number;
};

function computeConstraintDurationMinutes(constraint: ScheduleConstraint | null) {
  if (
    constraint?.explicitHour == null ||
    constraint.minute == null ||
    constraint.endExplicitHour == null ||
    constraint.endMinute == null
  ) {
    return null;
  }

  return constraint.endExplicitHour * 60 + constraint.endMinute - (constraint.explicitHour * 60 + constraint.minute);
}

function computeStartAt(input: ComputeStartAtInput) {
  const start = new Date(input.referenceTime);
  start.setUTCSeconds(0, 0);
  const constraintDurationMinutes = computeConstraintDurationMinutes(input.constraint);

  if (input.constraint) {
    if (input.constraint.relativeMinutes != null) {
      return advanceForConflicts(
        new Date(start.getTime() + input.constraint.relativeMinutes * 60_000),
        input.profile.focusBlockMinutes,
        input.existingBlocks
      );
    }

    const hour = input.constraint.explicitHour ?? preferredWindowHour(input.constraint.preferredWindow);
    const localDate = resolveConstraintLocalDate(
      start,
      input.profile.timezone,
      input.constraint,
      input.constraintBaseDate
    );

    return advanceForConflicts(
      buildDateInTimeZone({
        timeZone: input.profile.timezone,
        year: localDate.year,
        month: localDate.month,
        day: localDate.day,
        hour,
        minute: input.constraint.minute ?? 0
      }),
      constraintDurationMinutes ?? input.profile.focusBlockMinutes,
      input.existingBlocks
    );
  }

  const localDate = getTimeZoneDateParts(start, input.profile.timezone);
  let candidate = buildDateInTimeZone({
    timeZone: input.profile.timezone,
    year: localDate.year,
    month: localDate.month,
    day: localDate.day,
    hour: input.profile.workdayStartHour + input.slotOffset,
    minute: 0
  });

  if (candidate <= input.referenceTime) {
    const nextLocalDate = addDaysToLocalDate(localDate, 1);
    candidate = buildDateInTimeZone({
      timeZone: input.profile.timezone,
      year: nextLocalDate.year,
      month: nextLocalDate.month,
      day: nextLocalDate.day,
      hour: input.profile.workdayStartHour + input.slotOffset,
      minute: 0
    });
  }

  return advanceForConflicts(candidate, input.profile.focusBlockMinutes, input.existingBlocks);
}

function computeEndAt(input: ComputeStartAtInput) {
  const start = computeStartAt(input);
  const durationMinutes = computeConstraintDurationMinutes(input.constraint) ?? input.profile.focusBlockMinutes;
  return new Date(start.getTime() + durationMinutes * 60_000);
}

function advanceForConflicts(start: Date, durationMinutes: number, existingBlocks: ScheduleBlock[]) {
  const candidate = new Date(start);

  while (hasBlockConflict(candidate, durationMinutes, existingBlocks)) {
    candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
  }

  return candidate;
}

function preferredWindowHour(window: ScheduleConstraint["preferredWindow"]) {
  if (window === "morning") {
    return 9;
  }

  if (window === "afternoon") {
    return 14;
  }

  if (window === "evening") {
    return 18;
  }

  return 9;
}

function getTimeZoneDateParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);

  return {
    year: Number(getDateTimePart(parts, "year")),
    month: Number(getDateTimePart(parts, "month")),
    day: Number(getDateTimePart(parts, "day")),
    hour: Number(getDateTimePart(parts, "hour")),
    minute: Number(getDateTimePart(parts, "minute")),
    second: Number(getDateTimePart(parts, "second"))
  };
}

function getDateTimePart(
  parts: Intl.DateTimeFormatPart[],
  type: "year" | "month" | "day" | "hour" | "minute" | "second"
) {
  const match = parts.find((part) => part.type === type);

  if (!match) {
    throw new Error(`Missing ${type} while formatting timezone parts.`);
  }

  return match.value;
}

function addDaysToLocalDate(
  date: { year: number; month: number; day: number },
  dayCount: number
) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + dayCount, 0, 0, 0));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function resolveConstraintLocalDate(
  now: Date,
  timeZone: string,
  constraint: ScheduleConstraint,
  baseDate?: Date
) {
  if (
    baseDate &&
    constraint.dayReference === null &&
    constraint.weekday === null &&
    constraint.weekOffset === null
  ) {
    const baseLocalDate = getTimeZoneDateParts(baseDate, timeZone);

    return {
      year: baseLocalDate.year,
      month: baseLocalDate.month,
      day: baseLocalDate.day
    };
  }

  const localDate = getTimeZoneDateParts(now, timeZone);

  if (constraint.dayReference === null || constraint.dayReference === "today") {
    return {
      year: localDate.year,
      month: localDate.month,
      day: localDate.day
    };
  }

  if (constraint.dayReference === "tomorrow") {
    return addDaysToLocalDate(localDate, 1);
  }

  return addDaysToLocalDate(
    localDate,
    daysUntilWeekday(getWeekdayInTimeZone(now, timeZone), constraint.weekday, constraint.weekOffset)
  );
}

function getWeekdayInTimeZone(date: Date, timeZone: string): Weekday {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long"
  }).format(date).toLowerCase();

  return weekdaySchema.parse(formatted);
}

function daysUntilWeekday(
  currentWeekday: Weekday,
  targetWeekday: Weekday | null,
  weekOffset: number | null
) {
  if (targetWeekday === null) {
    throw new Error("weekday scheduling requires a target weekday.");
  }

  if (weekOffset === null) {
    throw new Error("weekday scheduling requires a weekOffset.");
  }

  const weekdayOrder = weekdaySchema.options;
  const currentIndex = weekdayOrder.indexOf(currentWeekday);
  const targetIndex = weekdayOrder.indexOf(targetWeekday);

  return (targetIndex - currentIndex + 7) % 7 + weekOffset * 7;
}

function buildDateInTimeZone(input: {
  timeZone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}) {
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);
  let candidate = targetUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getTimeZoneDateParts(new Date(candidate), input.timeZone);
    const observedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const diff = targetUtc - observedUtc;

    if (diff === 0) {
      return new Date(candidate);
    }

    candidate += diff;
  }

  return new Date(candidate);
}

function hasBlockConflict(start: Date, durationMinutes: number, existingBlocks: ScheduleBlock[]) {
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  return existingBlocks.some((block) => {
    const blockStart = Date.parse(block.startAt);
    const blockEnd = Date.parse(block.endAt);
    return start.getTime() < blockEnd && end.getTime() > blockStart;
  });
}

export async function processInboxItem(input: unknown) {
  return inboxPlanningOutputSchema.parse(input);
}

export async function replanTask(input: unknown) {
  return {
    accepted: true,
    input,
    message: "Replanning logic is not implemented yet."
  };
}

export function buildScheduleBlocksFromTasks(tasks: Task[]): ScheduleBlock[] {
  return tasks.flatMap((task) => {
    if (task.calendarSyncStatus === "out_of_sync") {
      return [];
    }

    const block = buildScheduleBlockFromTask(task);
    return block ? [block] : [];
  });
}

export function buildBusyScheduleBlocks(input: {
  userId: string;
  periods: CalendarBusyPeriod[];
}): ScheduleBlock[] {
  return input.periods.map((period, index) =>
    scheduleBlockSchema.parse({
      id: `external_busy_${period.externalCalendarId}_${index + 1}`,
      userId: input.userId,
      taskId: `external_busy_${index + 1}`,
      startAt: period.startAt,
      endAt: period.endAt,
      confidence: 1,
      reason: "External calendar busy time.",
      rescheduleCount: 0,
      externalCalendarId: period.externalCalendarId
    })
  );
}

export function detectTaskCalendarDrift(input: {
  task: Task;
  liveEvent:
    | {
        externalCalendarEventId: string;
        externalCalendarId: string;
        scheduledStartAt: string;
        scheduledEndAt: string;
      }
    | null;
}): TaskCalendarDrift | null {
  const { task, liveEvent } = input;

  if (task.externalCalendarEventId === null || task.externalCalendarId === null) {
    return null;
  }

  if (liveEvent === null) {
    return taskCalendarDriftSchema.parse({
      taskId: task.id,
      reason: "missing_event",
      expectedStartAt: task.scheduledStartAt,
      expectedEndAt: task.scheduledEndAt,
      actualStartAt: null,
      actualEndAt: null
    });
  }

  const startChanged = task.scheduledStartAt !== liveEvent.scheduledStartAt;
  const endChanged = task.scheduledEndAt !== liveEvent.scheduledEndAt;
  const calendarChanged = task.externalCalendarId !== liveEvent.externalCalendarId;

  if (!startChanged && !endChanged && !calendarChanged) {
    return null;
  }

  return taskCalendarDriftSchema.parse({
    taskId: task.id,
    reason: "calendar_changed",
    expectedStartAt: task.scheduledStartAt,
    expectedEndAt: task.scheduledEndAt,
    actualStartAt: liveEvent.scheduledStartAt,
    actualEndAt: liveEvent.scheduledEndAt
  });
}

export function buildScheduleBlockFromTask(task: Task): ScheduleBlock | null {
  if (
    task.externalCalendarEventId === null ||
    task.externalCalendarId === null ||
    task.scheduledStartAt === null ||
    task.scheduledEndAt === null
  ) {
    return null;
  }

  return scheduleBlockSchema.parse({
    id: task.externalCalendarEventId,
    userId: task.userId,
    taskId: task.id,
    startAt: task.scheduledStartAt,
    endAt: task.scheduledEndAt,
    confidence: 1,
    reason: "Current external-calendar-backed commitment.",
    rescheduleCount: task.rescheduleCount,
    externalCalendarId: task.externalCalendarId
  });
}

export function isTaskFollowupDue(task: Task, now = new Date().toISOString()) {
  return (
    task.lifecycleState === "scheduled" &&
    task.scheduledEndAt !== null &&
    Date.parse(task.scheduledEndAt) <= Date.parse(now)
  );
}

export function isTaskFollowupReminderDue(task: Task, now = new Date().toISOString()) {
  return (
    task.lifecycleState === "awaiting_followup" &&
    task.lastFollowupAt !== null &&
    task.followupReminderSentAt === null &&
    Date.parse(task.lastFollowupAt) + 2 * 60 * 60 * 1000 <= Date.parse(now)
  );
}
