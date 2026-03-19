ALTER TABLE "tasks" ADD COLUMN "calendar_sync_status" varchar(32) DEFAULT 'in_sync' NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "calendar_sync_updated_at" timestamp with time zone;

CREATE TABLE "google_calendar_accounts" (
  "user_id" text PRIMARY KEY NOT NULL,
  "provider_account_id" text NOT NULL,
  "email" text NOT NULL,
  "selected_calendar_id" text NOT NULL,
  "selected_calendar_name" text NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text,
  "token_expires_at" timestamp with time zone,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sync_cursor" text,
  "last_synced_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "google_calendar_oauth_states" (
  "state" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "redirect_path" text,
  "expires_at" timestamp with time zone NOT NULL,
  "code_verifier" text,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
