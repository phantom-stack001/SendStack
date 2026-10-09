import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DATABASE_MIGRATION_REQUIRED,
  DATABASE_UNAVAILABLE,
  INTERNAL_ERROR,
  classifyDbError,
  describeErrorForLog,
  isSchemaDriftError,
  redactForLog,
  safeClientMessage,
} from "../lib/db-errors";
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  REQUIRED_MIGRATIONS,
  evaluateSchema,
  summarizeSchemaEvaluation,
} from "../lib/schema-contract";

const run = promisify(execFile);
const webRoot = join(__dirname, "..");
const tsx = join(webRoot, "node_modules/.bin/tsx");

function pgError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** Env with the inherited database target removed, then explicit overrides applied. */
function envWithout(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return { ...env, ...extra };
}

const COMPLETE_FACTS = {
  tables: [
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
  ],
  columns: [
    "contacts.consent_evidence",
    "contacts.consent_attested_by",
    "contacts.consent_verified_at",
    "campaigns.launch_job_id",
    "campaigns.submission_state",
    "campaigns.frozen_at",
    "campaigns.launch_snapshot",
    "campaigns.reply_to_email",
    "campaigns.provider_status",
    "campaigns.cancellable",
    "campaign_recipients.first_name",
    "campaign_recipients.last_name",
    "campaign_attachments.blocked",
    "messages.volume_reservation_id",
    "messages.status_rank",
    "messages.idempotency_key",
    "messages.is_test",
    "messages.diagnostic_json",
    "suppressions.protected",
    "provider_events.claim_owner",
    "provider_events.claim_expires_at",
    "provider_events.claim_token",
    "provider_events.waived_at",
    "provider_events.resolved_at",
    "daily_volume_reservations.attempt_key",
    "launch_jobs.lease_generation",
    "launch_jobs.live_mode",
    "launch_jobs.max_attempts",
    "launch_jobs.next_retry_at",
    "launch_jobs.terminal_reason",
    "launch_jobs.submit_attempted_at",
    "login_attempts.account_key",
  ],
  indexes: [
    "daily_volume_reservations_day_key_uidx",
    "launch_jobs_one_active_per_campaign",
    "provider_events_claim_token_uidx",
    "messages_idempotency_key_uidx",
    "login_attempts_account_time_idx",
  ],
  constraints: [
    "contacts_status_check",
    "campaigns_status_check",
    "campaign_recipients_status_check",
    "suppressions_reason_check",
    "launch_jobs_status_check",
  ],
  appliedMigrations: [...REQUIRED_MIGRATIONS],
};

describe("migration target fingerprint", () => {
  it("differs when the host differs and the database name does not", async () => {
    const { migrationTargetIdentity } = await import("../lib/migration-target");
    const left = migrationTargetIdentity(
      "postgresql://user:secret@db-host-a.example:5432/neondb",
      "neondb",
    );
    const right = migrationTargetIdentity(
      "postgresql://user:secret@db-host-b.example:5432/neondb",
      "neondb",
    );
    expect(left.fingerprint).not.toBe(right.fingerprint);
    expect(left.database).toBe("neondb");
    expect(left.fingerprint).not.toContain("secret");
  });

  it("rejects a URL whose database name does not match current_database()", async () => {
    const { migrationTargetIdentity } = await import("../lib/migration-target");
    expect(() =>
      migrationTargetIdentity("postgresql://user:secret@127.0.0.1:5432/other", "neondb"),
    ).toThrow(/current_database/);
  });
});

describe("schema contract evaluation", () => {
  it("passes when every required object is present", () => {
    const evaluation = evaluateSchema(COMPLETE_FACTS);
    expect(evaluation.ok).toBe(true);
    expect(summarizeSchemaEvaluation(evaluation)).toMatch(/matches/i);
  });

  it("detects the exact pre-0006 production failure (missing volume tables)", () => {
    const evaluation = evaluateSchema({
      ...COMPLETE_FACTS,
      tables: COMPLETE_FACTS.tables.filter(
        (name) =>
          ![
            "daily_volume_counters",
            "daily_volume_reservations",
            "launch_jobs",
            "launch_job_imports",
            "delivery_health_blocks",
          ].includes(name),
      ),
      appliedMigrations: REQUIRED_MIGRATIONS.slice(0, 4),
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.missing_tables).toContain("daily_volume_counters");
    expect(evaluation.missing_migrations).toEqual([
      "0005_deliverability_hardening.sql",
      "0006_consent_volume_launch_hardening.sql",
      "0007_submission_state_machine.sql",
      "0008_drop_consent_gate.sql",
    ]);
    expect(summarizeSchemaEvaluation(evaluation)).toMatch(/migration required/i);
  });

  it("detects a missing correctness index", () => {
    const evaluation = evaluateSchema({
      ...COMPLETE_FACTS,
      indexes: COMPLETE_FACTS.indexes.filter(
        (name) => name !== "launch_jobs_one_active_per_campaign",
      ),
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.missing_indexes).toEqual(["launch_jobs_one_active_per_campaign"]);
  });

  it("detects a missing contacts status constraint", () => {
    const evaluation = evaluateSchema({
      ...COMPLETE_FACTS,
      constraints: COMPLETE_FACTS.constraints.filter((name) => name !== "contacts_status_check"),
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.missing_constraints).toEqual(["contacts_status_check"]);
  });

  it("flags ledger entries this release does not know about", () => {
    const evaluation = evaluateSchema({
      ...COMPLETE_FACTS,
      appliedMigrations: [...REQUIRED_MIGRATIONS, "0009_future_release.sql"],
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.unknown_migrations).toEqual(["0009_future_release.sql"]);
  });

  it("fails readiness when a recorded checksum does not match this release", () => {
    const evaluation = evaluateSchema({
      ...COMPLETE_FACTS,
      checksums: [{ id: "0004_contact_delete_fk.sql", recorded: "abc", expected: "def" }],
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.checksum_drift).toEqual(["0004_contact_delete_fk.sql"]);
    expect(summarizeSchemaEvaluation(evaluation)).toMatch(/checksum drift/i);
  });

  it("uses a stable advisory lock key", () => {
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBe("8534221907442113");
  });
});

describe("database error sanitization", () => {
  it("never returns raw relation-missing text to a client", () => {
    const error = pgError("42P01", 'relation "daily_volume_counters" does not exist');
    const classified = classifyDbError(error);
    expect(classified.code).toBe(DATABASE_MIGRATION_REQUIRED);
    expect(classified.status).toBe(503);
    expect(classified.migrationRequired).toBe(true);
    expect(classified.message).not.toMatch(/daily_volume_counters/);
    expect(classified.message).not.toMatch(/relation/i);
  });

  it("treats missing columns and schemas as migration-required", () => {
    expect(classifyDbError(pgError("42703", 'column "status_rank" does not exist')).code).toBe(
      DATABASE_MIGRATION_REQUIRED,
    );
    expect(classifyDbError(pgError("3F000", 'schema "public" does not exist')).code).toBe(
      DATABASE_MIGRATION_REQUIRED,
    );
    expect(isSchemaDriftError(pgError("42P01", "x"))).toBe(true);
    expect(isSchemaDriftError(new Error("plain"))).toBe(false);
  });

  it("maps connection failures to a transient 503", () => {
    const classified = classifyDbError(pgError("ECONNREFUSED", "connect ECONNREFUSED"));
    expect(classified.code).toBe(DATABASE_UNAVAILABLE);
    expect(classified.status).toBe(503);
  });

  it("maps unknown failures to a generic 500 with no detail", () => {
    const classified = classifyDbError(new Error("boom at /var/task/lib/secret.js:42"));
    expect(classified.code).toBe(INTERNAL_ERROR);
    expect(classified.status).toBe(500);
    expect(classified.message).toBe("Unexpected server error.");
  });

  it("passes application validation text through but replaces driver text", () => {
    expect(safeClientMessage(new Error("Could not remove suppression."), "fallback")).toBe(
      "Could not remove suppression.",
    );
    const dbMessage = safeClientMessage(
      pgError("42P01", 'relation "launch_jobs" does not exist'),
      "fallback",
    );
    expect(dbMessage).not.toMatch(/launch_jobs/);
    expect(dbMessage).toMatch(/schema is behind this release/i);
  });

  it("redacts connection strings, tokens, and addresses from logs", () => {
    const raw =
      "failed postgresql://user:pw@db.example.com/neondb key re_abc123DEF456ghi with Bearer abcdef1234567890 for a@b.com";
    const redacted = redactForLog(raw);
    expect(redacted).not.toMatch(/pw@/);
    expect(redacted).not.toMatch(/re_abc123DEF456ghi/);
    expect(redacted).not.toMatch(/abcdef1234567890/);
    expect(redacted).not.toMatch(/a@b\.com/);
  });

  it("keeps SQLSTATE in server logs while dropping the driver sentence", () => {
    const line = describeErrorForLog(
      pgError("42P01", 'relation "daily_volume_counters" does not exist'),
    );
    expect(line).toMatch(/sqlstate=42P01/);
    expect(line).toMatch(/code=database_migration_required/);
  });
});

describe("migration runner requires an explicit target", () => {
  it("refuses to run when DATABASE_URL is not injected", async () => {
    await expect(
      run(tsx, ["scripts/migrate.ts"], { cwd: webRoot, env: envWithout() }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("DATABASE_URL is required"),
    });
  });

  it("states that it never reads dotenv files, so no .env.local fallback exists", async () => {
    const failure = await run(tsx, ["scripts/migrate.ts"], {
      cwd: webRoot,
      env: envWithout(),
    }).catch((error: { stderr: string }) => error);
    expect((failure as { stderr: string }).stderr).toMatch(/never reads \.env\.local/);
  });

  it("rejects a non-postgres connection string", async () => {
    await expect(
      run(tsx, ["scripts/migrate.ts"], {
        cwd: webRoot,
        env: envWithout({ DATABASE_URL: "mysql://root@localhost/app" }),
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("must be a postgresql:// connection string"),
    });
  });

  it("rejects unknown options instead of silently ignoring them", async () => {
    await expect(
      run(tsx, ["scripts/migrate.ts", "--yolo"], {
        cwd: webRoot,
        env: envWithout({ DATABASE_URL: "postgresql://u@127.0.0.1:1/x" }),
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Unknown option --yolo") });
  });
});

describe("seed script refuses unsafe targets", () => {
  it("requires an explicitly injected DATABASE_URL", async () => {
    await expect(
      run(tsx, ["scripts/seed.ts"], { cwd: webRoot, env: envWithout() }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("must be injected explicitly"),
    });
  });

  it("refuses a non-local database even when injected", async () => {
    await expect(
      run(tsx, ["scripts/seed.ts"], {
        cwd: webRoot,
        env: envWithout({
          DATABASE_URL: "postgresql://u:p@db.example.neon.tech/neondb?sslmode=require",
        }),
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Refusing to seed a non-local database"),
    });
  });
});
