import { getPool } from "./db";

/**
 * Shared ordering key for the irreversible send and for suppression / health-block
 * commits. A session lock is held across the final check and the provider call.
 * Suppression and health-block transactions take the matching transaction lock,
 * so they either commit before that check or wait until after the call.
 * Repeated checks without this lock do not close the race.
 */
export const SUBMIT_BARRIER_LOCK_KEY = "8534221907442114";

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

export async function lockSubmitBarrier(client: Queryable): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [SUBMIT_BARRIER_LOCK_KEY]);
}

export async function withSubmitBarrier<T>(fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [SUBMIT_BARRIER_LOCK_KEY]);
    locked = true;
    return await fn();
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [SUBMIT_BARRIER_LOCK_KEY]).catch(() => undefined);
    }
    client.release();
  }
}
