import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import {
  PostgresInboxProcessingStore,
  PostgresIncomingTelegramIngressStore,
  recordIncomingTelegramMessageIfNew
} from "@atlas/db";
import { getDefaultCalendarAdapter, resetCalendarAdapterForTests } from "@atlas/integrations";

import { processInboxItem } from "../../apps/web/src/lib/server/process-inbox-item";

const databaseUrl = process.env.DATABASE_URL;
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/db/drizzle"
);

if (!databaseUrl) {
  describe.skip("postgres process inbox item", () => {
    it("requires DATABASE_URL to run", () => {});
  });
} else {
  describe("postgres process inbox item", () => {
    const sql = postgres(databaseUrl, {
      prepare: false
    });
    const ingressStore = new PostgresIncomingTelegramIngressStore(databaseUrl);
    const processingStore = new PostgresInboxProcessingStore(databaseUrl);

    beforeEach(async () => {
      await sql.unsafe("drop schema if exists public cascade;");
      await sql.unsafe("create schema if not exists public;");
      await applyMigrations(sql);
      resetCalendarAdapterForTests();
    });

    afterAll(async () => {
      await ingressStore.close();
      await processingStore.close();
      await sql.end();
    });

    it("creates a task, task-backed current commitment, and planner run for a first-seen inbox item", async () => {
      const ingress = await recordIncomingTelegramMessageIfNew(
        {
          userId: "123",
          eventType: "telegram_message",
          idempotencyKey: "telegram:webhook:update:42",
          payload: {
            update_id: 42
          },
          rawText: "Review launch checklist",
          normalizedText: "Review launch checklist"
        },
        ingressStore
      );

      if (ingress.status !== "recorded") {
        throw new Error("Expected recorded ingress for test setup.");
      }

      const result = await processInboxItem(
        {
          inboxItemId: ingress.inboxItem.id
        },
        {
          store: processingStore,
          calendar: getDefaultCalendarAdapter(),
          planner: async () => ({
            confidence: 0.9,
            summary: "Captured and scheduled Review launch checklist.",
            userReplyMessage: "Got it, I've added 'Review launch checklist' to your schedule for tomorrow at 9am.",
            actions: [
              {
                type: "create_task",
                alias: "new_task_1",
                title: "Review launch checklist",
                priority: "medium",
                urgency: "medium"
              },
              {
                type: "create_schedule_block",
                taskRef: {
                  kind: "created_task",
                  alias: "new_task_1"
                },
                scheduleConstraint: {
                  dayReference: null,
                  weekday: null,
                  weekOffset: null,
                  explicitHour: 9,
                  minute: 0,
                  preferredWindow: null,
                  sourceText: "default next slot"
                },
                reason: "Schedule the new task in the next slot."
              }
            ]
          })
        }
      );

      expect(result.outcome).toBe("planned");

      const insertedTasks = await sql`
        select title, lifecycle_state, external_calendar_event_id, external_calendar_id, scheduled_start_at, scheduled_end_at
        from tasks
      `;
      const insertedPlannerRuns = await sql`select version, model_input->>'now' as now from planner_runs`;
      const updatedInbox = await sql`select processing_status from inbox_items where id = ${ingress.inboxItem.id}`;

      expect(insertedTasks).toHaveLength(1);
      expect(insertedTasks[0]).toMatchObject({
        title: "Review launch checklist",
        lifecycle_state: "scheduled",
        external_calendar_id: "primary"
      });
      expect(insertedTasks[0]?.external_calendar_event_id).toBeTruthy();
      expect(insertedTasks[0]?.scheduled_start_at).toBeTruthy();
      expect(insertedTasks[0]?.scheduled_end_at).toBeTruthy();
      expect(insertedPlannerRuns).toHaveLength(1);
      expect(insertedPlannerRuns[0]?.now).toBeTruthy();
      expect(updatedInbox[0]?.processing_status).toBe("planned");
    });

    it("updates a planned block from a follow-up move request when there is one safe target", async () => {
      const firstIngress = await recordIncomingTelegramMessageIfNew(
        {
          userId: "123",
          eventType: "telegram_message",
          idempotencyKey: "telegram:webhook:update:50",
          payload: {
            update_id: 50
          },
          rawText: "Review launch checklist",
          normalizedText: "Review launch checklist"
        },
        ingressStore
      );

      if (firstIngress.status !== "recorded") {
        throw new Error("Expected recorded ingress for test setup.");
      }

      await processInboxItem(
        {
          inboxItemId: firstIngress.inboxItem.id
        },
        {
          store: processingStore,
          calendar: getDefaultCalendarAdapter(),
          planner: async () => ({
            confidence: 0.9,
            summary: "Captured and scheduled Review launch checklist.",
            userReplyMessage: "Got it, I've added 'Review launch checklist' to your schedule for tomorrow at 9am.",
            actions: [
              {
                type: "create_task",
                alias: "new_task_1",
                title: "Review launch checklist",
                priority: "medium",
                urgency: "medium"
              },
              {
                type: "create_schedule_block",
                taskRef: {
                  kind: "created_task",
                  alias: "new_task_1"
                },
                scheduleConstraint: {
                  dayReference: null,
                  weekday: null,
                  weekOffset: null,
                  explicitHour: 9,
                  minute: 0,
                  preferredWindow: null,
                  sourceText: "default next slot"
                },
                reason: "Schedule the new task in the next slot."
              }
            ]
          })
        }
      );

      const moveIngress = await recordIncomingTelegramMessageIfNew(
        {
          userId: "123",
          eventType: "telegram_message",
          idempotencyKey: "telegram:webhook:update:51",
          payload: {
            update_id: 51
          },
          rawText: "move it to 3pm",
          normalizedText: "move it to 3pm"
        },
        ingressStore
      );

      if (moveIngress.status !== "recorded") {
        throw new Error("Expected recorded ingress for move setup.");
      }

      const result = await processInboxItem(
        {
          inboxItemId: moveIngress.inboxItem.id
        },
        {
          store: processingStore,
          calendar: getDefaultCalendarAdapter(),
          planner: async () => ({
            confidence: 0.84,
            summary: "Moved it to 3pm.",
            userReplyMessage: "Perfect, I've moved it to 3pm.",
            actions: [
              {
                type: "move_schedule_block",
                blockRef: {
                  alias: "schedule_block_1"
                },
                scheduleConstraint: {
                  dayReference: null,
                  weekday: null,
                  weekOffset: null,
                  explicitHour: 15,
                  minute: 0,
                  preferredWindow: null,
                  sourceText: "at 3pm"
                },
                reason: "The user asked to move it to 3pm."
              }
            ]
          })
        }
      );

      expect(result.outcome).toBe("updated_schedule");

      const updatedTasks = await sql`
        select scheduled_start_at, reschedule_count, external_calendar_event_id
        from tasks
      `;
      expect(updatedTasks[0]?.reschedule_count).toBe(1);
      expect(updatedTasks[0]?.external_calendar_event_id).toBeTruthy();
      expect(new Date(updatedTasks[0]?.scheduled_start_at as string | Date).toISOString()).toBe(
        "2026-03-18T22:00:00.000Z"
      );
    });

    it("backfills task-level current commitment fields during the 0006 migration", async () => {
      const legacySql = postgres(databaseUrl, {
        prepare: false
      });

      try {
        await legacySql.unsafe("drop schema if exists public cascade;");
        await legacySql.unsafe("create schema if not exists public;");
        await applyMigrations(legacySql, "0005_task_centric_tasks.sql");

        await legacySql`
          insert into tasks (
            id,
            user_id,
            source_inbox_item_id,
            last_inbox_item_id,
            title,
            lifecycle_state,
            reschedule_count,
            priority,
            urgency
          ) values (
            '00000000-0000-4000-8000-000000000010',
            '123',
            '00000000-0000-4000-8000-000000000011',
            '00000000-0000-4000-8000-000000000011',
            'Review launch checklist',
            'scheduled',
            0,
            'medium',
            'medium'
          )
        `;
        await legacySql`
          insert into schedule_blocks (
            id,
            user_id,
            task_id,
            action_id,
            start_at,
            end_at,
            confidence,
            reason,
            reschedule_count,
            external_calendar_id
          ) values (
            '00000000-0000-4000-8000-000000000099',
            '123',
            '00000000-0000-4000-8000-000000000010',
            null,
            '2026-03-14T17:00:00.000Z',
            '2026-03-14T18:00:00.000Z',
            0.8,
            'Legacy schedule block',
            0,
            'primary'
          )
        `;
        await legacySql`
          update tasks
          set current_commitment_id = '00000000-0000-4000-8000-000000000099'
          where id = '00000000-0000-4000-8000-000000000010'
        `;

        const migrationContents = await readFile(
          path.join(migrationsDir, "0006_external_calendar_task_fields.sql"),
          "utf8"
        );
        const statements = migrationContents
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter(Boolean);

        for (const statement of statements) {
          await legacySql.unsafe(statement);
        }

        const migratedTasks = await legacySql`
          select external_calendar_event_id, external_calendar_id, scheduled_start_at, scheduled_end_at
          from tasks
          where id = '00000000-0000-4000-8000-000000000010'
        `;

        expect(migratedTasks[0]).toMatchObject({
          external_calendar_event_id: "00000000-0000-4000-8000-000000000099",
          external_calendar_id: "primary"
        });
        expect(migratedTasks[0]?.scheduled_start_at).toBeTruthy();
        expect(migratedTasks[0]?.scheduled_end_at).toBeTruthy();
      } finally {
        await legacySql.end();
      }
    });
  });
}

async function applyMigrations(sql: ReturnType<typeof postgres>, throughFile?: string) {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    if (throughFile && file > throughFile) {
      break;
    }

    const contents = await readFile(path.join(migrationsDir, file), "utf8");
    const statements = contents
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  }
}
