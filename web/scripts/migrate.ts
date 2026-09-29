/**
 * Migration runner.
 *
 * Release-safety rules enforced here:
 *  1. The target database must be injected explicitly as DATABASE_URL. This file
 *     deliberately does not import lib/config, so no dotenv file (.env.local,
 *     .env, .env.production) can silently choose the target.
 *  2. Only one runner may act on a database at a time (advisory lock).
 *  3. Applied migration files are checksummed; editing an applied file is refused.
 *  4. The ledger is validated for gaps and unknown entries before applying.
 *  5. After applying, the resulting schema is asserted against schema-contract.ts.
 *
 * Usage:
 *   DATABASE_URL=... tsx scripts/migrate.ts [--dry-run] [--expect-fingerprint=<hex10>] [--confirm-target=<hex10>] [--allow-drift]
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { migrationTargetIdentity } from "../lib/migration-target";
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  REQUIRED_MIGRATIONS,
  evaluateSchema,
  summarizeSchemaEvaluation,
} from "../lib/schema-contract";

const MIGRATIONS_DIR = join(__dirname, "../drizzle");

type Args = {
  dryRun: boolean;
  expectFingerprint: string | null;
  confirmTarget: string | null;
  allowDrift: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, expectFingerprint: null, confirmTarget: null, allowDrift: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--allow-drift") args.allowDrift = true;
    else if (arg.startsWith("--expect-fingerprint="))
      args.expectFingerprint = arg.slice("--expect-fingerprint=".length).trim();
    else if (arg.startsWith("--confirm-target="))
      args.confirmTarget = arg.slice("--confirm-target=".length).trim();
    else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return args;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function resolveTarget(): string {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required and must be injected explicitly for migrations.\n" +
        "This runner never reads .env.local, .env, or .env.production, so the target is always deliberate.\n" +
        "Local:      DATABASE_URL='postgresql://…@127.0.0.1:55432/sendstack_test' pnpm db:migrate\n" +
        "Production: inject the protected production URL into the process environment only.",
    );
  }
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error("DATABASE_URL must be a postgresql:// connection string.");
  }
  return url;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = resolveTarget();

  const client = new Client({
    connectionString,
    connectionTimeoutMillis:
      Number(process.env.SENDSTACK_DB_CONNECT_TIMEOUT_MS ?? 15_000) || 15_000,
    statement_timeout:
      Number(process.env.SENDSTACK_DB_STATEMENT_TIMEOUT_MS ?? 180_000) || 180_000,
  });
  await client.connect();

  let lockHeld = false;
  try {
    const identity = await client.query<{
      db: string;
      schema: string;
      search_path: string;
      in_recovery: boolean;
    }>(
      `SELECT current_database() AS db, current_schema() AS schema,
              current_setting('search_path') AS search_path,
              pg_is_in_recovery() AS in_recovery`,
    );
    const target = identity.rows[0]!;
    const targetIdentity = migrationTargetIdentity(connectionString, target.db);
    const targetFingerprint = targetIdentity.fingerprint;
    console.log(
      `Target: fingerprint=${targetFingerprint} schema=${target.schema} search_path=${target.search_path} local=${targetIdentity.local}`,
    );

    if (!args.dryRun && !targetIdentity.local && args.confirmTarget !== targetFingerprint) {
      throw new Error(
        `Refusing to migrate a non-local database without --confirm-target=${targetFingerprint}. Dry-run does not write.`,
      );
    }

    if (target.in_recovery) {
      throw new Error("Refusing to migrate: the target is a read replica (in recovery).");
    }
    if (args.expectFingerprint && args.expectFingerprint !== targetFingerprint) {
      throw new Error(
        `Refusing to migrate: expected database fingerprint ${args.expectFingerprint} but connected to ${targetFingerprint}.`,
      );
    }

    // One runner per database. try_lock (not lock) so a concurrent run fails fast
    // instead of queueing behind a long migration and doubling the window.
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
      [MIGRATION_ADVISORY_LOCK_KEY],
    );
    lockHeld = lock.rows[0]?.acquired === true;
    if (!lockHeld) {
      throw new Error(
        "Another migration process holds the advisory lock on this database. Refusing to run concurrently.",
      );
    }

    if (!args.dryRun) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Ledger integrity columns are additive and owned by the runner, so drift
      // detection works on databases migrated before this runner existed.
      await client.query(`
        ALTER TABLE schema_migrations
          ADD COLUMN IF NOT EXISTS checksum TEXT,
          ADD COLUMN IF NOT EXISTS checksum_source TEXT,
          ADD COLUMN IF NOT EXISTS duration_ms INTEGER
      `);
    }

    const files = migrationFiles();
    const known = new Set(files);
    const ledgerExists = await client.query<{ rel: string | null }>(
      `SELECT to_regclass(current_schema() || '.schema_migrations')::text AS rel`,
    );
    const checksumColumn = ledgerExists.rows[0]?.rel
      ? await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'schema_migrations'
                AND column_name = 'checksum'
           ) AS exists`,
        )
      : { rows: [{ exists: false }] };
    const hasChecksum = checksumColumn.rows[0]?.exists === true;
    // A dry-run against a ledger created before this runner has no checksum
    // column. Reading id only keeps the plan free of writes.
    const ledger = !ledgerExists.rows[0]?.rel
      ? { rows: [] as Array<{ id: string; checksum: string | null; checksum_source: string | null }> }
      : hasChecksum
        ? await client.query<{
            id: string;
            checksum: string | null;
            checksum_source: string | null;
          }>(`SELECT id, checksum, checksum_source FROM schema_migrations ORDER BY id`)
        : await client.query<{
            id: string;
            checksum: string | null;
            checksum_source: string | null;
          }>(
            `SELECT id, NULL::text AS checksum, NULL::text AS checksum_source
               FROM schema_migrations ORDER BY id`,
          );

    const orphaned = ledger.rows.filter((row) => !known.has(row.id)).map((row) => row.id);
    if (orphaned.length) {
      throw new Error(
        `Ledger drift: schema_migrations records migrations that do not exist on disk: ${orphaned.join(", ")}. ` +
          "This database was migrated by a different or newer release.",
      );
    }

    // Checksum verification for already-applied files.
    const drift: string[] = [];
    const baselined: string[] = [];
    for (const row of ledger.rows) {
      const current = checksum(readFileSync(join(MIGRATIONS_DIR, row.id), "utf8"));
      if (row.checksum === null) {
        if (!args.dryRun) {
          await client.query(
            `UPDATE schema_migrations SET checksum = $2, checksum_source = 'baseline' WHERE id = $1`,
            [row.id, current],
          );
        }
        baselined.push(row.id);
      } else if (row.checksum !== current) {
        drift.push(row.id);
      }
    }
    if (baselined.length) {
      const verb = args.dryRun ? "Would baseline" : "Recorded baseline";
      console.log(
        `${verb} checksums for ${baselined.length} previously applied migration(s): ${baselined.join(", ")}`,
      );
    }
    if (drift.length) {
      const message =
        `Checksum drift: applied migration file(s) changed since they were applied: ${drift.join(", ")}. ` +
        "Applied migrations are immutable — add a new migration instead.";
      if (!args.allowDrift) throw new Error(message);
      console.warn(`WARNING (--allow-drift): ${message}`);
    }

    // Out-of-order protection: refuse a new migration that sorts before an applied one.
    const appliedIds = new Set(ledger.rows.map((row) => row.id));
    const pending = files.filter((file) => !appliedIds.has(file));
    const highestApplied = [...appliedIds].sort().pop() ?? "";
    const outOfOrder = pending.filter((file) => file < highestApplied);
    if (outOfOrder.length) {
      throw new Error(
        `Out-of-order migrations detected: ${outOfOrder.join(", ")} sort before the applied migration ${highestApplied}. ` +
          "Renumber them after the latest applied migration.",
      );
    }

    console.log(
      pending.length
        ? `Pending: ${pending.join(", ")}`
        : "Pending: none (database is up to date)",
    );

    if (args.dryRun) {
      console.log("Dry run: no statements were executed.");
      if (ledgerExists.rows[0]?.rel) {
        await assertSchema(client, { afterApply: false });
      } else {
        console.warn("Schema assertion (pre-apply): schema_migrations does not exist.");
      }
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const startedAt = Date.now();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (id, applied_at, checksum, checksum_source, duration_ms)
           VALUES ($1, NOW(), $2, 'applied', $3)`,
          [file, checksum(sql), Date.now() - startedAt],
        );
        await client.query("COMMIT");
        console.log(`Applied ${file} (${Date.now() - startedAt}ms)`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    await assertSchema(client, { afterApply: true });
    console.log("Migrations complete.");
  } finally {
    if (lockHeld) {
      await client
        .query(`SELECT pg_advisory_unlock($1::bigint)`, [MIGRATION_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

/** Post-migration assertion: the live schema must satisfy the code's contract. */
async function assertSchema(client: Client, options: { afterApply: boolean }) {
  const [tables, columns, indexes, constraints, ledger, triggers] = await Promise.all([
    client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    ),
    client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()`,
    ),
    client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
    ),
    client.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = current_schema()`,
    ),
    client.query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`),
    client.query<{ tgname: string }>(
      `SELECT t.tgname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND NOT t.tgisinternal`,
    ),
  ]);

  const evaluation = evaluateSchema({
    tables: tables.rows.map((row) => row.table_name),
    columns: columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
    indexes: indexes.rows.map((row) => row.indexname),
    constraints: constraints.rows.map((row) => row.conname),
    appliedMigrations: ledger.rows.map((row) => row.id),
    triggers: triggers.rows.map((row) => row.tgname),
  });

  if (evaluation.ok) {
    console.log(
      `Schema assertions passed (${REQUIRED_MIGRATIONS.length} required migrations present).`,
    );
    return;
  }
  const summary = summarizeSchemaEvaluation(evaluation);
  if (options.afterApply) {
    throw new Error(`Post-migration schema assertion failed. ${summary}`);
  }
  console.warn(`Schema assertion (pre-apply): ${summary}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
