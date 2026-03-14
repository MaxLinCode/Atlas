import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import {
  PostgresIncomingTelegramIngressStore,
  recordIncomingTelegramMessageIfNew
} from "@atlas/db";

const databaseUrl = process.env.DATABASE_URL;
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/db/drizzle"
);

if (!databaseUrl) {
  describe.skip("postgres ingress persistence", () => {
    it("requires DATABASE_URL to run", () => {});
  });
} else {
  describe("postgres ingress persistence", () => {
    const sql = postgres(databaseUrl, {
      prepare: false
    });
    const store = new PostgresIncomingTelegramIngressStore(databaseUrl);

    beforeEach(async () => {
      await sql.unsafe("drop schema if exists public cascade;");
      await sql.unsafe("create schema if not exists public;");
      await applyMigrations(sql);
    });

    afterAll(async () => {
      await store.close();
      await sql.end();
    });

    it("persists first-seen ingress into bot_events and inbox_items and deduplicates repeats", async () => {
      const first = await recordIncomingTelegramMessageIfNew(
        {
          userId: "123",
          eventType: "telegram_message",
          idempotencyKey: "telegram:webhook:update:42",
          payload: {
            update_id: 42
          },
          rawText: " Review   launch checklist ",
          normalizedText: "Review launch checklist"
        },
        store
      );

      expect(first.status).toBe("recorded");

      const insertedBotEvents = await sql`
        select id, user_id, idempotency_key
        from bot_events
      `;
      const insertedInboxItems = await sql`
        select id, user_id, source_event_id, raw_text, normalized_text
        from inbox_items
      `;

      expect(insertedBotEvents).toHaveLength(1);
      expect(insertedBotEvents[0]).toMatchObject({
        id: first.status === "recorded" ? first.eventId : "",
        user_id: "123",
        idempotency_key: "telegram:webhook:update:42"
      });

      expect(insertedInboxItems).toHaveLength(1);
      expect(insertedInboxItems[0]).toMatchObject({
        id: first.status === "recorded" ? first.inboxItem.id : "",
        user_id: "123",
        source_event_id: first.status === "recorded" ? first.eventId : "",
        raw_text: " Review   launch checklist ",
        normalized_text: "Review launch checklist"
      });

      const duplicate = await recordIncomingTelegramMessageIfNew(
        {
          userId: "123",
          eventType: "telegram_message",
          idempotencyKey: "telegram:webhook:update:42",
          payload: {
            update_id: 42
          },
          rawText: " Review   launch checklist ",
          normalizedText: "Review launch checklist"
        },
        store
      );

      expect(duplicate).toEqual({
        status: "duplicate"
      });

      const botEventCount = await sql`select count(*)::int as count from bot_events`;
      const inboxItemCount = await sql`select count(*)::int as count from inbox_items`;

      expect(botEventCount[0]?.count).toBe(1);
      expect(inboxItemCount[0]?.count).toBe(1);
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
