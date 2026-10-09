import type postgres from "postgres";

export type DatabaseIdentity = {
  host: string;
  database: string;
  user: string;
  port: string;
};

export function parseDatabaseUrl(databaseUrl: string): DatabaseIdentity {
  const normalized = databaseUrl.replace(/^postgresql:/, "http:");
  const url = new URL(normalized);
  return {
    host: url.hostname,
    database: url.pathname.replace(/^\//, ""),
    user: url.username,
    port: url.port || "5432",
  };
}

export async function fetchDatabaseInventory(sql: postgres.Sql) {
  const [identity] = await sql`
    SELECT
      current_database() AS database,
      current_user AS db_user,
      version() AS version
  `;

  const tables = await sql`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;

  return {
    identity,
    tables: tables.map((row) => `${row.table_schema}.${row.table_name}`),
  };
}
