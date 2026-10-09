ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "queue_paused" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "queue_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "enqueued_at" timestamp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"campaign_recipient_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"bullmq_job_id" text,
	"queue_generation" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"scheduled_at" timestamp,
	"started_at" timestamp,
	"finished_at" timestamp,
	"last_error_code" text,
	"last_error_message" text,
	"skip_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_job_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_job_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "queue_events" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text,
	"delivery_job_id" text,
	"actor_user_id" text,
	"event_type" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_campaign_recipient_id_campaign_recipients_id_fk" FOREIGN KEY ("campaign_recipient_id") REFERENCES "public"."campaign_recipients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_job_attempts" ADD CONSTRAINT "delivery_job_attempts_delivery_job_id_delivery_jobs_id_fk" FOREIGN KEY ("delivery_job_id") REFERENCES "public"."delivery_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_delivery_job_id_delivery_jobs_id_fk" FOREIGN KEY ("delivery_job_id") REFERENCES "public"."delivery_jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_jobs_campaign_recipient_generation_unique" ON "delivery_jobs" USING btree ("campaign_id","campaign_recipient_id","queue_generation");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_jobs_user_id_status_idx" ON "delivery_jobs" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_jobs_campaign_id_idx" ON "delivery_jobs" USING btree ("campaign_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_jobs_status_scheduled_idx" ON "delivery_jobs" USING btree ("status","scheduled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_job_attempts_delivery_job_id_idx" ON "delivery_job_attempts" USING btree ("delivery_job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queue_events_campaign_id_created_at_idx" ON "queue_events" USING btree ("campaign_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queue_events_delivery_job_id_idx" ON "queue_events" USING btree ("delivery_job_id");
--> statement-breakpoint
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_status_check" CHECK ("status" IN ('pending', 'queued', 'processing', 'retry_wait', 'simulation_completed', 'simulation_failed', 'skipped', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "campaigns_status_check";
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_status_check" CHECK ("status" IN ('draft', 'ready', 'scheduled', 'queued', 'processing', 'paused', 'simulation_completed', 'simulation_failed', 'cancelled', 'sending', 'completed', 'failed'));
