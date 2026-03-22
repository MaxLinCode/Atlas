CREATE TABLE "conversation_discourse_states" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(32) NOT NULL,
	"label" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"summary_text" text,
	"mode" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_discourse_states" ADD CONSTRAINT "conversation_discourse_states_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_entities" ADD CONSTRAINT "conversation_entities_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_discourse_states_user_id_updated_at_idx" ON "conversation_discourse_states" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversation_entities_conversation_id_updated_at_idx" ON "conversation_entities" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversation_entities_user_id_updated_at_idx" ON "conversation_entities" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversation_turns_conversation_id_created_at_idx" ON "conversation_turns" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_turns_user_id_created_at_idx" ON "conversation_turns" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_user_id_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_updated_at_idx" ON "conversations" USING btree ("updated_at");
