import { randomUUID } from "node:crypto";

import { z } from "zod";

export * from "./telegram";

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
  OPENAI_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1)
});

export type AppConfig = z.infer<typeof envSchema>;

export function getConfig(overrides: Partial<Record<keyof AppConfig, string>> = {}) {
  return envSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    ...overrides
  });
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
  linkedTaskIds: z.array(z.string()).default([])
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
  rescheduleCount: z.number().int().nonnegative(),
  lastFollowupAt: z.string().datetime().nullable().default(null),
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

export const scheduleConstraintSchema = z.object({
  dayOffset: z.number().int().min(0).max(14),
  explicitHour: z.number().int().min(0).max(23).nullable(),
  minute: z.number().int().min(0).max(59),
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
  scheduleConstraint: scheduleConstraintSchema,
  reason: z.string().min(1)
});

export const moveScheduleBlockPlanningActionSchema = z.object({
  type: z.literal("move_schedule_block"),
  blockRef: scheduleBlockReferenceSchema,
  scheduleConstraint: scheduleConstraintSchema,
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
  clarifyPlanningActionSchema
]);

export const inboxPlanningOutputSchema = z.object({
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  actions: z.array(planningActionSchema).min(1)
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
  now: z.string().datetime().optional()
});

export const conversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  createdAt: z.string().datetime()
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
  recentTurns: z.array(conversationTurnSchema)
});

export const turnRoutingOutputSchema = z.object({
  route: turnRouteSchema,
  reason: z.string().min(1)
});

export const confirmedMutationRecoveryInputSchema = z.object({
  rawText: z.string().min(1),
  normalizedText: z.string().min(1),
  recentTurns: z.array(conversationTurnSchema),
  memorySummary: z.string().nullable()
});

export const confirmedMutationRecoveryOutputSchema = z.object({
  outcome: z.enum(["recovered", "needs_clarification"]),
  recoveredRawText: z.string().optional(),
  recoveredNormalizedText: z.string().optional(),
  reason: z.string().min(1)
}).refine((data) => {
  if (data.outcome === "recovered") {
    return data.recoveredRawText && data.recoveredNormalizedText;
  }
  return true;
}, {
  message: "recoveredRawText and recoveredNormalizedText are required when outcome is 'recovered'"
});

export const scheduleProposalInputSchema = z.object({
  userId: z.string(),
  openTasks: z.array(taskSchema),
  userProfile: userProfileSchema,
  existingBlocks: z.array(scheduleBlockSchema),
  scheduleConstraint: scheduleConstraintSchema.nullable().optional(),
  now: z.string().datetime().optional()
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
export type ScheduleProposalInput = z.infer<typeof scheduleProposalInputSchema>;
export type ScheduleProposalOutput = z.infer<typeof scheduleProposalOutputSchema>;
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskAction = z.infer<typeof taskActionSchema>;
export type TaskCandidate = z.infer<typeof taskCandidateSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type PlanningAction = z.infer<typeof planningActionSchema>;
export type InboxPlanningOutput = z.infer<typeof inboxPlanningOutputSchema>;
export type TaskReference = z.infer<typeof taskReferenceSchema>;
export type ScheduleBlockReference = z.infer<typeof scheduleBlockReferenceSchema>;
export type InboxPlanningContext = z.infer<typeof inboxPlanningContextSchema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type TurnRoute = z.infer<typeof turnRouteSchema>;
export type TurnRoutingInput = z.infer<typeof turnRoutingInputSchema>;
export type TurnRoutingOutput = z.infer<typeof turnRoutingOutputSchema>;
export type ConfirmedMutationRecoveryInput = z.infer<typeof confirmedMutationRecoveryInputSchema>;
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
  recoveredRawText: string;
  recoveredNormalizedText: string;
} => {
  return (
    output.outcome === "recovered" &&
    typeof output.recoveredRawText === "string" &&
    typeof output.recoveredNormalizedText === "string"
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
    rescheduleCount: 0,
    lastFollowupAt: null,
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
  now?: string;
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
    ...(input.now ? { now: input.now } : {})
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
  const now = new Date(parsed.now ?? new Date().toISOString());

  const inserts = parsed.openTasks.map((task, index) =>
    scheduleBlockSchema.parse({
      id: randomUUID(),
      userId: task.userId,
      taskId: task.id,
      startAt: computeStartAt({
        now,
        profile,
        existingBlocks: parsed.existingBlocks,
        constraint: parsed.scheduleConstraint ?? null,
        slotOffset: index
      }).toISOString(),
      endAt: computeEndAt({
        now,
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
  scheduleConstraint: ScheduleConstraint;
  existingBlocks: ScheduleBlock[];
  now?: string;
}) {
  const now = new Date(input.now ?? new Date().toISOString());
  const durationMinutes =
    Math.max(15, Math.round((Date.parse(input.block.endAt) - Date.parse(input.block.startAt)) / 60000)) || 60;
  const startAt = computeStartAt({
    now,
    profile: input.userProfile,
    existingBlocks: input.existingBlocks.filter((block) => block.id !== input.block.id),
    constraint: input.scheduleConstraint,
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
  now: Date;
  profile: UserProfile;
  existingBlocks: ScheduleBlock[];
  constraint: ScheduleConstraint | null;
  slotOffset: number;
};

function computeStartAt(input: ComputeStartAtInput) {
  const start = new Date(input.now);
  start.setUTCSeconds(0, 0);

  if (input.constraint) {
    start.setUTCDate(start.getUTCDate() + input.constraint.dayOffset);

    const hour = input.constraint.explicitHour ?? preferredWindowHour(input.constraint.preferredWindow);
    start.setUTCHours(hour, input.constraint.minute, 0, 0);
  } else {
    start.setUTCHours(input.profile.workdayStartHour + input.slotOffset, 0, 0, 0);
    if (start <= input.now) {
      start.setUTCDate(start.getUTCDate() + 1);
    }
  }

  while (hasBlockConflict(start, input.profile.focusBlockMinutes, input.existingBlocks)) {
    start.setUTCHours(start.getUTCHours() + 1, 0, 0, 0);
  }

  return start;
}

function computeEndAt(input: ComputeStartAtInput) {
  const start = computeStartAt(input);
  return new Date(start.getTime() + input.profile.focusBlockMinutes * 60_000);
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
    const block = buildScheduleBlockFromTask(task);
    return block ? [block] : [];
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
