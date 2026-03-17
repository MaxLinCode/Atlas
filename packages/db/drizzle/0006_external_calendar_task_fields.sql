ALTER TABLE "tasks" ADD COLUMN "external_calendar_event_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "external_calendar_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "scheduled_start_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "scheduled_end_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "tasks" AS t
SET
  "external_calendar_event_id" = sc."id"::text,
  "external_calendar_id" = sc."external_calendar_id",
  "scheduled_start_at" = sc."start_at",
  "scheduled_end_at" = sc."end_at"
FROM "schedule_blocks" AS sc
WHERE t."current_commitment_id" = sc."id";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'tasks_current_commitment_id_schedule_blocks_id_fk'
  ) THEN
    ALTER TABLE "tasks" DROP CONSTRAINT "tasks_current_commitment_id_schedule_blocks_id_fk";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "current_commitment_id";
