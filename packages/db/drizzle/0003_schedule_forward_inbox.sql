ALTER TABLE "schedule_blocks" ALTER COLUMN "action_id" DROP NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'schedule_blocks'
      AND column_name = 'task_id'
  ) THEN
    ALTER TABLE "schedule_blocks" ADD COLUMN "task_id" uuid;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'schedule_blocks_task_id_tasks_id_fk'
  ) THEN
    ALTER TABLE "schedule_blocks"
      ADD CONSTRAINT "schedule_blocks_task_id_tasks_id_fk"
      FOREIGN KEY ("task_id")
      REFERENCES "public"."tasks"("id")
      ON DELETE no action
      ON UPDATE no action;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "schedule_blocks" ALTER COLUMN "task_id" SET NOT NULL;
