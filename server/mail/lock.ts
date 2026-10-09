import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "../db/index.js";

export type MailLock = <T>(task: () => Promise<T>) => Promise<T>;

/** Signed 64-bit key for pg_advisory_xact_lock. Stable for the same name. */
export function advisoryLockKey(name: string) {
  const digest = createHash("sha256").update(name).digest();
  return digest.readBigInt64BE(0).toString();
}

/**
 * Holds a transaction-scoped advisory lock for the whole task.
 * Transaction locks stay on one server connection, including through the pooler.
 */
export async function withPgAdvisoryLock<T>(db: Database, name: string, task: () => Promise<T>): Promise<T> {
  const key = advisoryLockKey(name);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(cast(${key} as bigint))`);
    return task();
  });
}
