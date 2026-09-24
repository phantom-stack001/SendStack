import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { config } from "./config";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations or seeds.");
  }
  const statementTimeoutMs = Number(process.env.SENDSTACK_DB_STATEMENT_TIMEOUT_MS ?? 30_000) || 30_000;
  pool ??= new Pool({
    connectionString: config.databaseUrl,
    max: Number(process.env.SENDSTACK_DB_POOL_MAX ?? 10) || 10,
    connectionTimeoutMillis: Number(process.env.SENDSTACK_DB_CONNECT_TIMEOUT_MS ?? 10_000) || 10_000,
    idleTimeoutMillis: Number(process.env.SENDSTACK_DB_IDLE_TIMEOUT_MS ?? 30_000) || 30_000,
    options: `-c statement_timeout=${statementTimeoutMs}`,
  });
  return pool;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}
