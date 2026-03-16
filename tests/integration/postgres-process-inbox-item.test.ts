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
    });

    afterAll(async () => {
      await ingressStore.close();
      await processingStore.close();
      await sql.end();
    });

    it("creates a task, schedule block, and planner run for a first-seen inbox item", async () => {
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
          planner: async () => ({
            confidence: 0.9,
            summary: "Captured and scheduled Review launch checklist.",
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
                  dayOffset: 0,
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

      const insertedTasks = await sql`select title from tasks`;
      const insertedBlocks = await sql`select task_id from schedule_blocks`;
      const insertedPlannerRuns = await sql`select version from planner_runs`;
      const updatedInbox = await sql`select processing_status from inbox_items where id = ${ingress.inboxItem.id}`;

      expect(insertedTasks).toHaveLength(1);
      expect(insertedBlocks).toHaveLength(1);
      expect(insertedPlannerRuns).toHaveLength(1);
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
          planner: async () => ({
            confidence: 0.9,
            summary: "Captured and scheduled Review launch checklist.",
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
                  dayOffset: 0,
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
          planner: async () => ({
            confidence: 0.84,
            summary: "Moved it to 3pm.",
            actions: [
              {
                type: "move_schedule_block",
                blockRef: {
                  alias: "schedule_block_1"
                },
                scheduleConstraint: {
                  dayOffset: 0,
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

      const updatedBlocks = await sql`select start_at, reschedule_count from schedule_blocks`;
      expect(updatedBlocks[0]?.reschedule_count).toBe(1);
    });

    it("enforces the current commitment foreign key on tasks", async () => {
      await expect(
        sql`
          insert into tasks (
            id,
            user_id,
            source_inbox_item_id,
            last_inbox_item_id,
            title,
            lifecycle_state,
            current_commitment_id,
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
            '00000000-0000-4000-8000-000000000099',
            0,
            'medium',
            'medium'
          )
        `
      ).rejects.toThrow();
    });
  });
}

async function applyMigrations(sql: ReturnType<typeof postgres>) {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
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
