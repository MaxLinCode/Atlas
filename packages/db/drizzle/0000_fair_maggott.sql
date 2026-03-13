CREATE TABLE "bot_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" varchar(16) NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"retry_state" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"raw_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"processing_status" varchar(32) NOT NULL,
	"confidence" real NOT NULL,
	"linked_task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planner_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"inbox_item_id" uuid,
	"version" varchar(32) NOT NULL,
	"model_input" jsonb NOT NULL,
	"model_output" jsonb,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"confidence" real NOT NULL,
	"reason" text NOT NULL,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"external_calendar_id" text
);
--> statement-breakpoint
CREATE TABLE "task_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"action_order" integer NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"breakdown_level" integer NOT NULL,
	"status" varchar(32) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source_inbox_item_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"priority" varchar(16) NOT NULL,
	"urgency" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text NOT NULL,
	"workday_start_hour" integer NOT NULL,
	"workday_end_hour" integer NOT NULL,
	"deep_work_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blackout_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"focus_block_minutes" integer NOT NULL,
	"reminder_style" varchar(16) NOT NULL,
	"breakdown_level" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bot_events_idempotency_key_idx" ON "bot_events" USING btree ("idempotency_key");