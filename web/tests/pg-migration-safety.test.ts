import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { query, resetPool } from "../lib/db";
import { inspectSchema } from "../lib/schema-guard";
import { MIGRATION_ADVISORY_LOCK_KEY } from "../lib/schema-contract";
import {
  applyTestEnv,
  canConnectToTestDatabase,
  resolveTestDatabaseUrl,
  wipePublicSchema,
} from "./pg-test-utils";

const run = promisify(execFile);
const webRoot = join(__dirname, "..");
const tsx = join(webRoot, "node_modules/.bin/tsx");
const MIGRATION_0004 = join(webRoot, "drizzle/0004_contact_delete_fk.sql");

const testUrl = resolveTestDatabaseUrl();
const dbAvailable = Boolean(testUrl) && (await canConnectToTestDatabase(testUrl!));

function migrate(args: string[] = []) {
  return run(tsx, ["scripts/migrate.ts", ...args], {
    cwd: webRoot,
    env: { ...process.env, DATABASE_URL: testUrl! },
  });
}

describe.skipIf(!dbAvailable)("migration runner safety (disposable PostgreSQL)", () => {
  beforeAll(async () => {
    applyTestEnv(testUrl!);
    await resetPool();
    await wipePublicSchema();
    await resetPool();
  });

  afterAll(async () => {
    await resetPool();
  });

  it("applies all migrations and records checksums", async () => {
    const { stdout } = await migrate();
    expect(stdout).toMatch(/Applied 0001_init\.sql/);
    expect(stdout).toMatch(/Applied 0006_consent_volume_launch_hardening\.sql/);
    expect(stdout).toMatch(/Applied 0007_submission_state_machine\.sql/);
    expect(stdout).toMatch(/Applied 0008_drop_consent_gate\.sql/);
    expect(stdout).toMatch(/Applied 0009_spacemail_parity\.sql/);
    expect(stdout).toMatch(/Schema assertions passed/);
    expect(stdout).toMatch(/Migrations complete/);

    const ledger = await query<{ id: string; checksum: string; checksum_source: string }>(
      `SELECT id, checksum, checksum_source FROM schema_migrations ORDER BY id`,
    );
    expect(ledger.rows).toHaveLength(9);
    expect(ledger.rows.map((row) => row.id)).toContain("0009_spacemail_parity.sql");
    for (const row of ledger.rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.checksum_source).toBe("applied");
    }
  });

  it("prints a sanitized fingerprint and never the connection string", async () => {
    const { stdout } = await migrate();
    expect(stdout).toMatch(/Target: fingerprint=[0-9a-f]{10}/);
    expect(stdout).not.toMatch(/postgres(ql)?:\/\//);
    expect(stdout).not.toContain("sendstack:sendstack");
  });

  it("is a no-op on a second run", async () => {
    const { stdout } = await migrate();
    expect(stdout).toMatch(/Pending: none/);
    expect(stdout).not.toMatch(/Applied /);
  });

  it("aborts when the expected database fingerprint does not match", async () => {
    await expect(migrate(["--expect-fingerprint=0000000000"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Refusing to migrate: expected database fingerprint"),
    });
  });

  it("refuses to run concurrently while the advisory lock is held", async () => {
    const holder = new Client({ connectionString: testUrl! });
    await holder.connect();
    try {
      const lock = await holder.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
        [MIGRATION_ADVISORY_LOCK_KEY],
      );
      expect(lock.rows[0]?.acquired).toBe(true);

      await expect(migrate()).rejects.toMatchObject({
        stderr: expect.stringContaining("holds the advisory lock"),
      });
    } finally {
      await holder
        .query(`SELECT pg_advisory_unlock($1::bigint)`, [MIGRATION_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  });

  it("releases the advisory lock so the next run succeeds", async () => {
    const { stdout } = await migrate();
    expect(stdout).toMatch(/Pending: none/);
  });

  it("detects checksum drift when an applied migration file is edited", async () => {
    const backup = `${MIGRATION_0004}.audit-backup`;
    copyFileSync(MIGRATION_0004, backup);
    try {
      const original = readFileSync(MIGRATION_0004, "utf8");
      writeFileSync(MIGRATION_0004, `${original}\n-- drift introduced by regression test\n`);

      await expect(migrate()).rejects.toMatchObject({
        stderr: expect.stringContaining("Checksum drift"),
      });
      const readiness = await inspectSchema();
      expect(readiness.ok).toBe(false);
      expect(readiness.checksum_drift).toContain("0004_contact_delete_fk.sql");

      // --allow-drift downgrades the refusal to a warning for deliberate recovery.
      const { stdout, stderr } = await migrate(["--allow-drift"]);
      expect(`${stdout}${stderr}`).toMatch(/WARNING \(--allow-drift\)/);
    } finally {
      copyFileSync(backup, MIGRATION_0004);
      await run("rm", ["-f", backup]);
    }
  });

  it("refuses when the ledger references a migration that no longer exists on disk", async () => {
    await query(
      `INSERT INTO schema_migrations (id, applied_at, checksum, checksum_source)
       VALUES ('9999_from_a_newer_release.sql', NOW(), 'deadbeef', 'applied')`,
    );
    try {
      await expect(migrate()).rejects.toMatchObject({
        stderr: expect.stringContaining("Ledger drift"),
      });
    } finally {
      await query(`DELETE FROM schema_migrations WHERE id = '9999_from_a_newer_release.sql'`);
    }
  });

  it("fails the post-apply assertion when a required object is dropped", async () => {
    await query(`DROP INDEX IF EXISTS launch_jobs_one_active_per_campaign`);
    try {
      // Nothing is pending, so assertions run against the damaged schema via --dry-run.
      const { stdout, stderr } = await migrate(["--dry-run"]);
      expect(`${stdout}${stderr}`).toMatch(/launch_jobs_one_active_per_campaign/);
    } finally {
      await query(
        `CREATE UNIQUE INDEX IF NOT EXISTS launch_jobs_one_active_per_campaign
           ON launch_jobs (campaign_id)
           WHERE status IN ('pending','running','ready_to_submit','submitting','reconciling','submission_unknown')`,
      );
    }
  });

  it("dry run reports pending work without executing it", async () => {
    await query(`DELETE FROM schema_migrations WHERE id = '0009_spacemail_parity.sql'`);
    const before = await query<{ id: string; checksum: string | null }>(
      `SELECT id, checksum FROM schema_migrations ORDER BY id`,
    );
    try {
      const { stdout } = await migrate(["--dry-run"]);
      expect(stdout).toMatch(/Pending: 0009_spacemail_parity\.sql/);
      expect(stdout).toMatch(/Dry run: no statements were executed/);
      const ledger = await query<{ id: string; checksum: string | null }>(
        `SELECT id, checksum FROM schema_migrations ORDER BY id`,
      );
      expect(ledger.rows).toEqual(before.rows);
    } finally {
      await migrate();
    }
  });

  it("dry-run plans a pre-checksum ledger without creating the checksum column", async () => {
    await query(`ALTER TABLE schema_migrations DROP COLUMN IF EXISTS checksum`);
    await query(`ALTER TABLE schema_migrations DROP COLUMN IF EXISTS checksum_source`);
    await query(`ALTER TABLE schema_migrations DROP COLUMN IF EXISTS duration_ms`);
    const before = await query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);
    try {
      const { stdout } = await migrate(["--dry-run"]);
      expect(stdout).toMatch(/Would baseline checksums for 9 previously applied migration/);
      expect(stdout).toMatch(/Pending: none/);
      expect(stdout).toMatch(/Dry run: no statements were executed/);
      expect(stdout).not.toMatch(/Applied /);
      const columns = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`,
      );
      expect(columns.rows.map((row) => row.column_name)).not.toContain("checksum");
      const after = await query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);
      expect(after.rows).toEqual(before.rows);
    } finally {
      await migrate();
    }
  });
});
