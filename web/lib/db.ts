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
    const rawConnect = pool.connect.bind(pool);
    // Ensure statement_timeout is applied before any caller query (avoids pg concurrent-query warning).
    pool.connect = ((arg?: unknown) => {
      const applyTimeout = async (client: import("pg").PoolClient) => {
        try {
          await client.query(`SET statement_timeout TO ${timeoutMs}`);
        } catch {
          // Ignore: some proxies disallow SET; queries can still proceed.
        }
        return client;
      };
      if (typeof arg === "function") {
        const callback = arg as (
          err: Error | undefined,
          client?: import("pg").PoolClient,
          done?: (release?: unknown) => void,
        ) => void;
        return rawConnect((err, client, done) => {
          if (err || !client) {
            callback(err, client, done);
            return;
          }
          void applyTimeout(client).then(
            (ready) => callback(undefined, ready, done),
            (applyErr) => callback(applyErr as Error, undefined, done),
          );
        }) as never;
      }
      return rawConnect().then(applyTimeout) as never;
    }) as typeof pool.connect;
  }
  return pool;
}

/** Test helper: close and drop the cached pool so a new DATABASE_URL can be used. */
export async function resetPool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  try {
    await Promise.race([
      closing.end().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  } catch {
    // Ignore close races in tests.
  }
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}
