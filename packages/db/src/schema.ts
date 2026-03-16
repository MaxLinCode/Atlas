import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
  uuid,
  varchar
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const inboxItems = pgTable("inbox_items", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  sourceEventId: uuid("source_event_id").references(() => botEvents.id),
  rawText: text("raw_text").notNull(),
  normalizedText: text("normalized_text").notNull(),
  processingStatus: varchar("processing_status", { length: 32 }).notNull(),
  linkedTaskIds: jsonb("linked_task_ids").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
},
  (table) => ({
    sourceEventIdIndex: uniqueIndex("inbox_items_source_event_id_idx")
      .on(table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`)
  })
);

export const scheduleBlocks = pgTable("schedule_blocks", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  taskId: uuid("task_id").notNull().references((): AnyPgColumn => tasks.id),
  actionId: uuid("action_id"),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  confidence: real("confidence").notNull(),
  reason: text("reason").notNull(),
  rescheduleCount: integer("reschedule_count").notNull().default(0),
  externalCalendarId: text("external_calendar_id")
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    sourceInboxItemId: uuid("source_inbox_item_id").notNull(),
    lastInboxItemId: uuid("last_inbox_item_id").notNull(),
    title: text("title").notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 32 }).notNull(),
    // Transitional until a dedicated commitments table lands.
    currentCommitmentId: uuid("current_commitment_id"),
    rescheduleCount: integer("reschedule_count").notNull().default(0),
    lastFollowupAt: timestamp("last_followup_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    priority: varchar("priority", { length: 16 }).notNull(),
    urgency: varchar("urgency", { length: 16 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    currentCommitmentFk: foreignKey({
      name: "tasks_current_commitment_id_schedule_blocks_id_fk",
      columns: [table.currentCommitmentId],
      foreignColumns: [scheduleBlocks.id]
    }).onDelete("set null")
  })
);

export const taskActions = pgTable("task_actions", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").notNull(),
  title: text("title").notNull(),
  actionOrder: integer("action_order").notNull(),
  estimatedMinutes: integer("estimated_minutes").notNull(),
  breakdownLevel: integer("breakdown_level").notNull(),
  status: varchar("status", { length: 32 }).notNull()
});

export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id").primaryKey(),
  timezone: text("timezone").notNull(),
  workdayStartHour: integer("workday_start_hour").notNull(),
  workdayEndHour: integer("workday_end_hour").notNull(),
  deepWorkWindows: jsonb("deep_work_windows").notNull().default([]),
  blackoutWindows: jsonb("blackout_windows").notNull().default([]),
  focusBlockMinutes: integer("focus_block_minutes").notNull(),
  reminderStyle: varchar("reminder_style", { length: 16 }).notNull(),
  breakdownLevel: integer("breakdown_level").notNull()
});

export const botEvents = pgTable(
  "bot_events",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    eventType: varchar("event_type", { length: 32 }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull(),
    retryState: varchar("retry_state", { length: 16 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    idempotencyKeyIndex: uniqueIndex("bot_events_idempotency_key_idx").on(table.idempotencyKey)
  })
);

export const plannerRuns = pgTable("planner_runs", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  inboxItemId: uuid("inbox_item_id"),
  version: varchar("version", { length: 32 }).notNull(),
  modelInput: jsonb("model_input").notNull(),
  modelOutput: jsonb("model_output"),
  confidence: real("confidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
