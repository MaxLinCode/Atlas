import { z } from "zod";

export * from "./telegram";

const envSchema = z.object({
  DATABASE_URL: z.string().url().default("https://example.invalid/db"),
  OPENAI_API_KEY: z.string().default("dev-openai-key"),
  TELEGRAM_BOT_TOKEN: z.string().default("dev-telegram-token"),
  TELEGRAM_WEBHOOK_SECRET: z.string().default("dev-webhook-secret")
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

export const inboxItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  rawText: z.string(),
  normalizedText: z.string(),
  processingStatus: z.enum(["received", "processing", "planned", "needs_clarification"]),
  confidence: z.number().min(0).max(1),
  linkedTaskIds: z.array(z.string()).default([])
});

export const taskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  status: z.enum(["open", "done", "archived"]),
  priority: z.enum(["low", "medium", "high"]),
  urgency: z.enum(["low", "medium", "high"]),
  energyTag: z.enum(["low", "medium", "high"]).optional(),
  sourceInboxItemId: z.string()
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
  actionId: z.string(),
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

export const plannerExtractionSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      priority: z.enum(["low", "medium", "high"]),
      urgency: z.enum(["low", "medium", "high"]),
      confidence: z.number().min(0).max(1)
    })
  )
});

export const scheduleProposalInputSchema = z.object({
  userId: z.string(),
  openActions: z.array(taskActionSchema),
  userProfile: userProfileSchema,
  existingBlocks: z.array(scheduleBlockSchema)
});

export const scheduleProposalOutputSchema = z.object({
  inserts: z.array(scheduleBlockSchema),
  moves: z.array(
    z.object({
      blockId: z.string(),
      newStartAt: z.string(),
      newEndAt: z.string(),
      reason: z.string()
    })
  )
});

export type InboxItem = z.infer<typeof inboxItemSchema>;
export type PlannerExtraction = z.infer<typeof plannerExtractionSchema>;
export type ScheduleProposalInput = z.infer<typeof scheduleProposalInputSchema>;
export type ScheduleProposalOutput = z.infer<typeof scheduleProposalOutputSchema>;
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskAction = z.infer<typeof taskActionSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;

export async function processInboxItem(input: unknown) {
  const parsed = plannerExtractionSchema.safeParse({
    tasks: [
      {
        title: "Review inbox item",
        priority: "medium",
        urgency: "medium",
        confidence: 0.5
      }
    ]
  });

  return {
    accepted: true,
    input,
    extraction: parsed.success ? parsed.data : null,
    message: "Core package is wired. Replace this stub with structured model calls."
  };
}

export async function buildScheduleProposal(input: ScheduleProposalInput) {
  const proposal = {
    inserts: [],
    moves: []
  };

  return scheduleProposalOutputSchema.parse(proposal);
}

export async function replanTask(input: unknown) {
  return {
    accepted: true,
    input,
    message: "Core package is wired. Replace this stub with replanning logic."
  };
}
