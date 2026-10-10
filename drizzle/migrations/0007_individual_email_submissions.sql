CREATE TABLE IF NOT EXISTS "individual_email_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_draft_id" text,
	"idempotency_key" text NOT NULL,
	"message_id" text,
	"sender_email" text NOT NULL,
	"to_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipient_summary" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"smtp_accepted_at" timestamp,
	"sent_copy_saved_at" timestamp,
	"sent_copy_status" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "individual_email_submissions" ADD CONSTRAINT "individual_email_submissions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "individual_email_submissions" ADD CONSTRAINT "individual_email_submissions_source_draft_id_email_drafts_id_fk" FOREIGN KEY ("source_draft_id") REFERENCES "public"."email_drafts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "individual_email_submissions_idempotency_key_unique" ON "individual_email_submissions" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "individual_email_submissions_user_created_idx" ON "individual_email_submissions" USING btree ("user_id","created_at");
