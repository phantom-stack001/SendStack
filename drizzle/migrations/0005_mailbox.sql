CREATE TABLE IF NOT EXISTS "mail_connection_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"smtp_status" text NOT NULL,
	"imap_status" text NOT NULL,
	"smtp_error" text,
	"imap_error" text,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"message_id" text,
	"status" text NOT NULL,
	"smtp_response" text,
	"accepted_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejected_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_copy_status" text,
	"sent_copy_error" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_connection_checks" ADD CONSTRAINT "mail_connection_checks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_submissions" ADD CONSTRAINT "mail_submissions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_submissions_idempotency_key_unique" ON "mail_submissions" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_submissions_created_at_idx" ON "mail_submissions" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_connection_checks_checked_at_idx" ON "mail_connection_checks" USING btree ("checked_at");
