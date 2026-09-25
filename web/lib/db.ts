import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { config } from "./config";

let pool: Pool | undefined;

function statementTimeoutMs(): number {
  return Number(process.env.SENDSTACK_DB_STATEMENT_TIMEOUT_MS ?? 30_000) || 30_000;
}

/**
 * Neon pooled (PgBouncer) connections reject startup `options` like statement_timeout.
 * Set the timeout after connect instead so both pooled and direct URLs work.
 */
export function getPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations or seeds.");
  }
  if (!pool) {
    const timeoutMs = statementTimeoutMs();
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.SENDSTACK_DB_POOL_MAX ?? 10) || 10,
      connectionTimeoutMillis: Number(process.env.SENDSTACK_DB_CONNECT_TIMEOUT_MS ?? 10_000) || 10_000,
      idleTimeoutMillis: Number(process.env.SENDSTACK_DB_IDLE_TIMEOUT_MS ?? 30_000) || 30_000,
    });
    pool.on("connect", (client) => {
      client.query(`SET statement_timeout TO ${timeoutMs}`).catch(() => {
        // Ignore: some proxies disallow SET; queries can still proceed.
      });
    });
  }
  return pool;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}
