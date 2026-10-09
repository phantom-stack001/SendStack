CREATE TABLE IF NOT EXISTS "email_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sender_name" text DEFAULT '' NOT NULL,
	"sender_email" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"content_json" jsonb,
	"body_html" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_drafts_user_id_updated_at_idx" ON "email_drafts" USING btree ("user_id","updated_at");
