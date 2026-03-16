ALTER TABLE "tasks" RENAME COLUMN "status" TO "lifecycle_state";
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_inbox_item_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_commitment_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reschedule_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_followup_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "tasks"
SET
  "last_inbox_item_id" = "source_inbox_item_id",
  "lifecycle_state" = CASE
    WHEN "lifecycle_state" = 'done' THEN 'completed'
    WHEN "lifecycle_state" = 'archived' THEN 'archived'
    ELSE 'scheduling'
  END;
--> statement-breakpoint
WITH latest_blocks AS (
  SELECT DISTINCT ON ("task_id")
    "id",
    "task_id",
    "reschedule_count"
  FROM "schedule_blocks"
  WHERE "task_id" IS NOT NULL
  ORDER BY "task_id", "start_at" DESC, "id" DESC
)
UPDATE "tasks" AS t
SET
  "current_commitment_id" = lb."id",
  "reschedule_count" = lb."reschedule_count",
  "lifecycle_state" = CASE
    WHEN t."lifecycle_state" IN ('completed', 'archived') THEN t."lifecycle_state"
    ELSE 'scheduled'
  END
FROM latest_blocks AS lb
WHERE t."id" = lb."task_id";
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "last_inbox_item_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_current_commitment_id_schedule_blocks_id_fk"
  FOREIGN KEY ("current_commitment_id")
  REFERENCES "public"."schedule_blocks"("id")
  ON DELETE set null
  ON UPDATE no action;
