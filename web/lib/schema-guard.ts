import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "./db";
import {
  evaluateSchema,
  summarizeSchemaEvaluation,
  type SchemaChecksumFact,
  type SchemaEvaluation,
} from "./schema-contract";

export type SchemaReport = SchemaEvaluation & {
  reachable: boolean;
  applied_migrations: string[];
  /** SQLSTATE when the database could not be inspected at all. */
  error_code?: string;
};

function migrationFileChecksum(id: string): string | null {
  const candidates = [
    join(process.cwd(), "drizzle", id),
    join(process.cwd(), "web", "drizzle", id),
    join(__dirname, "..", "drizzle", id),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return null;
  return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
}

const UNREACHABLE: SchemaEvaluation = {
  ok: false,
  missing_tables: [],
  missing_columns: [],
  missing_indexes: [],
  missing_constraints: [],
  missing_migrations: [],
  unknown_migrations: [],
  missing_triggers: [],
  checksum_drift: [],
};

/**
 * Inspect the live schema against the contract in schema-contract.ts.
 * Never throws: callers are health and readiness paths that must return a
 * structured status rather than surface a driver error.
 */
export async function inspectSchema(): Promise<SchemaReport> {
  try {
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    );
    const tableNames = tables.rows.map((row) => row.table_name);

    const columns = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()`,
    );

    const indexes = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
    );

    const constraints = await query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = current_schema()`,
    );

    const triggers = await query<{ tgname: string }>(
      `SELECT t.tgname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND NOT t.tgisinternal`,
    );

    let applied: string[] = [];
    let checksums: SchemaChecksumFact[] = [];
    if (tableNames.includes("schema_migrations")) {
      const columnNames = new Set(
        columns.rows
          .filter((row) => row.table_name === "schema_migrations")
          .map((row) => row.column_name),
      );
      if (columnNames.has("checksum")) {
        const ledger = await query<{ id: string; checksum: string | null }>(
          `SELECT id, checksum FROM schema_migrations ORDER BY id`,
        );
        applied = ledger.rows.map((row) => row.id);
        checksums = ledger.rows.map((row) => ({
          id: row.id,
          recorded: row.checksum,
          expected: row.checksum ? migrationFileChecksum(row.id) : null,
        }));
      } else {
        const ledger = await query<{ id: string }>(
          `SELECT id FROM schema_migrations ORDER BY id`,
        );
        applied = ledger.rows.map((row) => row.id);
      }
    }

    const evaluation = evaluateSchema({
      tables: tableNames,
      columns: columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
      indexes: indexes.rows.map((row) => row.indexname),
      constraints: constraints.rows.map((row) => row.conname),
      appliedMigrations: applied,
      triggers: triggers.rows.map((row) => row.tgname),
      checksums,
    });

    return { ...evaluation, reachable: true, applied_migrations: applied };
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unavailable";
    return {
      ...UNREACHABLE,
      reachable: false,
      applied_migrations: [],
      error_code: code,
    };
  }
}

export function summarizeSchemaReport(report: SchemaReport): string {
  if (!report.reachable) return "The database could not be inspected.";
  return summarizeSchemaEvaluation(report);
}

export {
  REQUIRED_MIGRATIONS,
  REQUIRED_TABLES,
  REQUIRED_COLUMNS,
  REQUIRED_INDEXES,
  REQUIRED_CONSTRAINTS,
} from "./schema-contract";
