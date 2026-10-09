/**
 * Explicit allowlist of SendStack-managed tables in the public schema.
 * Used by reset tooling — never drop objects outside this list.
 */
export const LEGACY_SENDSTACK_TABLES = [
  "audit_events",
  "campaign_recipients",
  "campaigns",
  "contacts",
  "daily_volume_counters",
  "daily_volume_reservations",
  "delivery_health_blocks",
  "launch_job_imports",
  "launch_jobs",
  "list_contacts",
  "lists",
  "login_attempts",
  "messages",
  "schema_migrations",
  "sessions",
  "suppressions",
  "users",
] as const;

export const BETTER_AUTH_TABLES = ["verification", "account", "session", "user"] as const;

export const SENDSTACK_APP_TABLES = [
  "email_drafts",
  "contacts",
  "contact_lists",
  "contact_list_members",
  "contact_consent_events",
  "email_suppressions",
  "campaigns",
  "campaign_recipient_sources",
  "campaign_recipients",
  "campaign_events",
  "delivery_jobs",
  "delivery_job_attempts",
  "queue_events",
] as const;

export const DRIZZLE_META_TABLES = ["__drizzle_migrations"] as const;

export const SENDSTACK_RESET_TABLES = [
  ...LEGACY_SENDSTACK_TABLES,
  ...SENDSTACK_APP_TABLES,
  ...BETTER_AUTH_TABLES,
  ...DRIZZLE_META_TABLES,
] as const;
