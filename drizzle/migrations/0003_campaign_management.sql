CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_draft_id" text,
	"sender_name" text DEFAULT '' NOT NULL,
	"sender_email" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"content_json" jsonb,
	"body_html" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"content_revision" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"scheduled_at" timestamp,
	"schedule_timezone" text,
	"eligible_recipient_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_recipient_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"source_type" text NOT NULL,
	"contact_id" text,
	"contact_list_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"contact_id" text,
	"email" text NOT NULL,
	"eligibility_status" text NOT NULL,
	"eligibility_reason" text DEFAULT '' NOT NULL,
	"evaluated_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_events" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_source_draft_id_email_drafts_id_fk" FOREIGN KEY ("source_draft_id") REFERENCES "public"."email_drafts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipient_sources" ADD CONSTRAINT "campaign_recipient_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipient_sources" ADD CONSTRAINT "campaign_recipient_sources_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipient_sources" ADD CONSTRAINT "campaign_recipient_sources_contact_list_id_contact_lists_id_fk" FOREIGN KEY ("contact_list_id") REFERENCES "public"."contact_lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_user_id_updated_at_idx" ON "campaigns" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_user_id_status_idx" ON "campaigns" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_recipient_sources_campaign_id_idx" ON "campaign_recipient_sources" USING btree ("campaign_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_recipient_sources_individual_unique" ON "campaign_recipient_sources" USING btree ("campaign_id","contact_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_recipient_sources_list_unique" ON "campaign_recipient_sources" USING btree ("campaign_id","contact_list_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_recipients_campaign_email_unique" ON "campaign_recipients" USING btree ("campaign_id","email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_recipients_campaign_id_idx" ON "campaign_recipients" USING btree ("campaign_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_events_campaign_id_created_at_idx" ON "campaign_events" USING btree ("campaign_id","created_at");
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_status_check" CHECK ("status" IN ('draft', 'ready', 'scheduled', 'queued', 'sending', 'completed', 'failed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "campaign_recipient_sources" ADD CONSTRAINT "campaign_recipient_sources_type_check" CHECK ("source_type" IN ('individual_contact', 'contact_list'));
