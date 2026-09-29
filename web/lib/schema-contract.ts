/**
 * The schema this code requires, as pure data.
 *
 * Deliberately free of imports so the migration runner can consume it without
 * pulling in the dotenv-loading application config.
 */

export const REQUIRED_MIGRATIONS = [
  "0001_init.sql",
  "0002_must_change_password.sql",
  "0003_campaign_attachments.sql",
  "0004_contact_delete_fk.sql",
  "0005_deliverability_hardening.sql",
  "0006_consent_volume_launch_hardening.sql",
  "0007_submission_state_machine.sql",
] as const;

export const REQUIRED_TABLES = [
  "users",
  "sessions",
  "login_attempts",
  "lists",
  "contacts",
  "list_contacts",
  "campaigns",
  "campaign_recipients",
  "campaign_attachments",
  "messages",
  "suppressions",
  "provider_events",
  "audit_events",
  "daily_volume_counters",
  "daily_volume_reservations",
  "launch_jobs",
  "launch_job_imports",
  "delivery_health_blocks",
  "schema_migrations",
] as const;

/** Columns added by 0005/0006 that the application reads or writes unconditionally. */
export const REQUIRED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["contacts", "consent_evidence"],
  ["contacts", "consent_attested_by"],
  ["contacts", "consent_verified_at"],
  ["campaigns", "launch_job_id"],
  ["campaigns", "submission_state"],
  ["campaigns", "frozen_at"],
  ["campaigns", "launch_snapshot"],
  ["campaigns", "reply_to_email"],
  ["campaigns", "provider_status"],
  ["campaigns", "cancellable"],
  ["campaign_recipients", "first_name"],
  ["campaign_recipients", "last_name"],
  ["campaign_attachments", "blocked"],
  ["messages", "volume_reservation_id"],
  ["messages", "status_rank"],
  ["messages", "idempotency_key"],
  ["messages", "is_test"],
  ["messages", "diagnostic_json"],
  ["suppressions", "protected"],
  ["provider_events", "claim_owner"],
  ["provider_events", "claim_expires_at"],
  ["provider_events", "claim_token"],
  ["provider_events", "waived_at"],
  ["provider_events", "resolved_at"],
  ["daily_volume_reservations", "attempt_key"],
  ["launch_jobs", "lease_generation"],
  ["launch_jobs", "live_mode"],
  ["launch_jobs", "max_attempts"],
  ["launch_jobs", "next_retry_at"],
  ["launch_jobs", "terminal_reason"],
  ["launch_jobs", "submit_attempted_at"],
  ["login_attempts", "account_key"],
];

/** Indexes that enforce correctness (not merely performance). */
export const REQUIRED_INDEXES = [
  "daily_volume_reservations_day_key_uidx",
  "launch_jobs_one_active_per_campaign",
  "provider_events_claim_token_uidx",
  "messages_idempotency_key_uidx",
  "login_attempts_account_time_idx",
] as const;

export const REQUIRED_TRIGGERS = ["launch_jobs_protect_submission"] as const;

/** Constraints that enforce consent and delivery-state integrity. */
export const REQUIRED_CONSTRAINTS = [
  "contacts_status_check",
  "contacts_active_requires_consent_check",
  "campaigns_status_check",
  "campaign_recipients_status_check",
  "suppressions_reason_check",
  "launch_jobs_status_check",
] as const;

/**
 * Advisory lock key: one migration runner per database at a time.
 * Kept as a decimal string because the value exceeds Number.MAX_SAFE_INTEGER
 * and the compile target predates BigInt literals; PostgreSQL casts it to bigint.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = "8534221907442113";

export type SchemaChecksumFact = {
  id: string;
  /** Recorded ledger checksum. Null means not yet baselined. */
  recorded: string | null;
  /** Checksum of the migration file in this release. Null means the file could not be read. */
  expected: string | null;
};

export type SchemaFacts = {
  tables: readonly string[];
  columns: readonly string[];
  indexes: readonly string[];
  constraints: readonly string[];
  appliedMigrations: readonly string[];
  triggers?: readonly string[];
  checksums?: readonly SchemaChecksumFact[];
};

export type SchemaEvaluation = {
  ok: boolean;
  missing_tables: string[];
  missing_columns: string[];
  missing_indexes: string[];
  missing_constraints: string[];
  missing_migrations: string[];
  unknown_migrations: string[];
  missing_triggers: string[];
  checksum_drift: string[];
};

/** Compare observed schema facts against the contract. Pure. */
export function evaluateSchema(facts: SchemaFacts): SchemaEvaluation {
  const tables = new Set(facts.tables);
  const columns = new Set(facts.columns);
  const indexes = new Set(facts.indexes);
  const constraints = new Set(facts.constraints);

  const missing_tables = REQUIRED_TABLES.filter((name) => !tables.has(name));
  const missing_columns = REQUIRED_COLUMNS.filter(
    ([table, column]) => tables.has(table) && !columns.has(`${table}.${column}`),
  ).map(([table, column]) => `${table}.${column}`);
  const missing_indexes = REQUIRED_INDEXES.filter((name) => !indexes.has(name));
  const missing_constraints = REQUIRED_CONSTRAINTS.filter(
    (name) => !constraints.has(name),
  );
  const missing_migrations = REQUIRED_MIGRATIONS.filter(
    (id) => !facts.appliedMigrations.includes(id),
  );
  const unknown_migrations = facts.appliedMigrations.filter(
    (id) => !REQUIRED_MIGRATIONS.includes(id as (typeof REQUIRED_MIGRATIONS)[number]),
  );
  const observedTriggers = new Set(facts.triggers ?? []);
  const missing_triggers =
    facts.triggers === undefined
      ? []
      : REQUIRED_TRIGGERS.filter((name) => !observedTriggers.has(name));
  const checksum_drift = (facts.checksums ?? [])
    .filter((row) => row.recorded && (!row.expected || row.recorded !== row.expected))
    .map((row) => row.id);

  return {
    ok:
      missing_tables.length === 0 &&
      missing_columns.length === 0 &&
      missing_indexes.length === 0 &&
      missing_constraints.length === 0 &&
      missing_migrations.length === 0 &&
      unknown_migrations.length === 0 &&
      missing_triggers.length === 0 &&
      checksum_drift.length === 0,
    missing_tables: [...missing_tables],
    missing_columns,
    missing_indexes: [...missing_indexes],
    missing_constraints: [...missing_constraints],
    missing_migrations: [...missing_migrations],
    unknown_migrations: [...unknown_migrations],
    missing_triggers: [...missing_triggers],
    checksum_drift,
  };
}

/** Operator-facing summary that never contains raw driver text. */
export function summarizeSchemaEvaluation(evaluation: SchemaEvaluation): string {
  if (evaluation.ok) return "Schema matches the code's required migrations.";
  const parts: string[] = [];
  if (evaluation.missing_migrations.length)
    parts.push(`missing migrations: ${evaluation.missing_migrations.join(", ")}`);
  if (evaluation.missing_tables.length)
    parts.push(`missing tables: ${evaluation.missing_tables.join(", ")}`);
  if (evaluation.missing_columns.length)
    parts.push(`missing columns: ${evaluation.missing_columns.join(", ")}`);
  if (evaluation.missing_indexes.length)
    parts.push(`missing indexes: ${evaluation.missing_indexes.join(", ")}`);
  if (evaluation.missing_constraints.length)
    parts.push(`missing constraints: ${evaluation.missing_constraints.join(", ")}`);
  if (evaluation.missing_triggers.length)
    parts.push(`missing triggers: ${evaluation.missing_triggers.join(", ")}`);
  if (evaluation.unknown_migrations.length)
    parts.push(`unknown migrations: ${evaluation.unknown_migrations.join(", ")}`);
  if (evaluation.checksum_drift.length)
    parts.push(`checksum drift: ${evaluation.checksum_drift.join(", ")}`);
  return `Database migration required (${parts.join("; ")}).`;
}
