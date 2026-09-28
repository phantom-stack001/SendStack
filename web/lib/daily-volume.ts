import type { PoolClient } from "pg";
import { config } from "./config";
import { getPool, query } from "./db";
import { makeId } from "./ids";

/** UTC calendar day used for all daily volume accounting. */
export function utcDayString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type ReserveResult =
  | { ok: true; reservationId: string; dayUtc: string; idempotent: boolean }
  | { ok: false; error: string; used: number; limit: number };

export type BatchReserveResult =
  | {
      ok: true;
      dayUtc: string;
      reservedNew: number;
      reservationIds: string[];
      idempotentKeys: string[];
    }
  | { ok: false; error: string; used: number; limit: number };

/**
 * Atomically reserve daily volume units.
 * Idempotent on reservationKey: retries reuse the existing reserved/consumed row
 * without increasing the counter again.
 * Status changes after consume never release capacity.
 */
export async function reserveDailyVolume(input: {
  reservationKey: string;
  units?: number;
  campaignId?: string | null;
  messageId?: string | null;
  limit?: number;
  now?: Date;
}): Promise<ReserveResult> {
  const units = input.units ?? 1;
  const limit = input.limit ?? config.dailyLimit;
  const dayUtc = utcDayString(input.now);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO daily_volume_counters (day_utc, reserved_units, created_at, updated_at)
       VALUES ($1::date, 0, NOW(), NOW())
       ON CONFLICT (day_utc) DO NOTHING`,
      [dayUtc],
    );
    await client.query(`SELECT day_utc FROM daily_volume_counters WHERE day_utc = $1::date FOR UPDATE`, [dayUtc]);

    const existing = await client.query<{ id: string; status: string; day_utc: string }>(
      `SELECT id, status, day_utc::text
         FROM daily_volume_reservations
        WHERE reservation_key = $1 AND day_utc = $2::date`,
      [input.reservationKey, dayUtc],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status === "released") {
        // Re-reserve released key under the same lock.
      } else {
        await client.query("COMMIT");
        return {
          ok: true,
          reservationId: existing.rows[0].id,
          dayUtc,
          idempotent: true,
        };
      }
    }

    const counter = await client.query<{ reserved_units: string }>(
      `SELECT reserved_units::int AS reserved_units FROM daily_volume_counters WHERE day_utc = $1::date`,
      [dayUtc],
    );
    const used = Number(counter.rows[0]?.reserved_units ?? 0);
    if (used + units > limit) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Daily delivery limit reached.", used, limit };
    }

    const reservationId = existing.rows[0]?.id || makeId("dvr");
    if (existing.rows[0]?.status === "released") {
      await client.query(
        `UPDATE daily_volume_reservations
            SET status = 'reserved', units = $1, campaign_id = $2, message_id = $3, updated_at = NOW(), day_utc = $4::date
          WHERE id = $5`,
        [units, input.campaignId ?? null, input.messageId ?? null, dayUtc, reservationId],
      );
    } else {
      await client.query(
        `INSERT INTO daily_volume_reservations
           (id, reservation_key, day_utc, units, status, campaign_id, message_id, created_at, updated_at)
         VALUES ($1, $2, $3::date, $4, 'reserved', $5, $6, NOW(), NOW())`,
        [reservationId, input.reservationKey, dayUtc, units, input.campaignId ?? null, input.messageId ?? null],
      );
    }
    await client.query(
      `UPDATE daily_volume_counters
          SET reserved_units = reserved_units + $1, updated_at = NOW()
        WHERE day_utc = $2::date`,
      [units, dayUtc],
    );
    await client.query("COMMIT");
    return { ok: true, reservationId, dayUtc, idempotent: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Set-based batch reservation: one counter lock, insert all new keys, increment once
 * by the count of newly reserved keys. Idempotent per reservation key.
 * Pass `client` to join an outer transaction (no BEGIN/COMMIT/release).
 */
export async function reserveDailyVolumeBatch(input: {
  reservationKeys: string[];
  campaignId: string;
  unitsPer?: number;
  limit?: number;
  now?: Date;
  attemptKey?: string | null;
  messageIdByKey?: Record<string, string | null | undefined>;
  client?: PoolClient;
}): Promise<BatchReserveResult & { batchId?: string }> {
  const unitsPer = input.unitsPer ?? 1;
  const limit = input.limit ?? config.dailyLimit;
  const dayUtc = utcDayString(input.now);
  const batchId = input.attemptKey ?? makeId("dvb");
  const keys = [...new Set(input.reservationKeys.map((key) => key.trim()).filter(Boolean))];
  if (!keys.length) {
    return { ok: true, dayUtc, reservedNew: 0, reservationIds: [], idempotentKeys: [], batchId };
  }

  const ownsTransaction = !input.client;
  const client = input.client ?? (await getPool().connect());
  try {
    if (ownsTransaction) await client.query("BEGIN");
    await client.query(
      `INSERT INTO daily_volume_counters (day_utc, reserved_units, created_at, updated_at)
       VALUES ($1::date, 0, NOW(), NOW())
       ON CONFLICT (day_utc) DO NOTHING`,
      [dayUtc],
    );
    await client.query(`SELECT day_utc FROM daily_volume_counters WHERE day_utc = $1::date FOR UPDATE`, [dayUtc]);

    const existing = await client.query<{ id: string; reservation_key: string; status: string }>(
      `SELECT id, reservation_key, status
         FROM daily_volume_reservations
        WHERE day_utc = $1::date
          AND reservation_key = ANY($2::text[])`,
      [dayUtc, keys],
    );
    const byKey = new Map(existing.rows.map((row) => [row.reservation_key, row]));
    const idempotentKeys: string[] = [];
    const toInsert: string[] = [];
    const toReReserve: { id: string; key: string }[] = [];

    for (const key of keys) {
      const row = byKey.get(key);
      if (!row) {
        toInsert.push(key);
      } else if (row.status === "released") {
        toReReserve.push({ id: row.id, key });
      } else {
        idempotentKeys.push(key);
      }
    }

    const newUnits = (toInsert.length + toReReserve.length) * unitsPer;
    const counter = await client.query<{ reserved_units: string }>(
      `SELECT reserved_units::int AS reserved_units FROM daily_volume_counters WHERE day_utc = $1::date`,
      [dayUtc],
    );
    const used = Number(counter.rows[0]?.reserved_units ?? 0);
    if (used + newUnits > limit) {
      if (ownsTransaction) await client.query("ROLLBACK");
      return { ok: false, error: "Daily delivery limit reached.", used, limit };
    }

    const reservationIds: string[] = existing.rows
      .filter((row) => row.status !== "released")
      .map((row) => row.id);

    for (const row of toReReserve) {
      await client.query(
        `UPDATE daily_volume_reservations
            SET status = 'reserved',
                units = $1,
                campaign_id = $2,
                message_id = COALESCE($3, message_id),
                attempt_key = COALESCE($4, attempt_key),
                updated_at = NOW(),
                day_utc = $5::date
          WHERE id = $6`,
        [
          unitsPer,
          input.campaignId,
          input.messageIdByKey?.[row.key] ?? null,
          batchId,
          dayUtc,
          row.id,
        ],
      );
      reservationIds.push(row.id);
    }

    for (const key of toInsert) {
      const id = makeId("dvr");
      await client.query(
        `INSERT INTO daily_volume_reservations
           (id, reservation_key, attempt_key, day_utc, units, status, campaign_id, message_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4::date, $5, 'reserved', $6, $7, NOW(), NOW())`,
        [id, key, batchId, dayUtc, unitsPer, input.campaignId, input.messageIdByKey?.[key] ?? null],
      );
      reservationIds.push(id);
    }

    if (newUnits > 0) {
      await client.query(
        `UPDATE daily_volume_counters
            SET reserved_units = reserved_units + $1, updated_at = NOW()
          WHERE day_utc = $2::date`,
        [newUnits, dayUtc],
      );
    }

    if (ownsTransaction) await client.query("COMMIT");
    return {
      ok: true,
      dayUtc,
      reservedNew: toInsert.length + toReReserve.length,
      reservationIds,
      idempotentKeys,
      batchId,
    };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/** Consume all reserved volume for a campaign after confirmed provider acceptance. */
export async function consumeDailyReservationsForCampaign(campaignId: string): Promise<number> {
  const result = await query(
    `UPDATE daily_volume_reservations
        SET status = 'consumed', updated_at = NOW()
      WHERE campaign_id = $1 AND status = 'reserved'
      RETURNING id`,
    [campaignId],
  );
  return result.rowCount ?? 0;
}

/** Mark reservation consumed after confirmed provider submission or durable local capture. */
export async function consumeDailyReservation(reservationId: string): Promise<void> {
  await query(
    `UPDATE daily_volume_reservations
        SET status = 'consumed', updated_at = NOW()
      WHERE id = $1 AND status = 'reserved'`,
    [reservationId],
  );
}

/**
 * Release only when it is confirmed that no provider submission occurred.
 * Never release consumed reservations (bounce/complaint/unsubscribe keep counting).
 */
export async function releaseDailyReservation(reservationId: string, confirmedNoProviderSubmission: boolean): Promise<boolean> {
  if (!confirmedNoProviderSubmission) return false;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ day_utc: string; units: string; status: string }>(
      `SELECT day_utc::text, units::int AS units, status
         FROM daily_volume_reservations WHERE id = $1 FOR UPDATE`,
      [reservationId],
    );
    const reservation = row.rows[0];
    if (!reservation || reservation.status !== "reserved") {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE daily_volume_reservations SET status = 'released', updated_at = NOW() WHERE id = $1`,
      [reservationId],
    );
    await client.query(
      `UPDATE daily_volume_counters
          SET reserved_units = GREATEST(0, reserved_units - $1), updated_at = NOW()
        WHERE day_utc = $2::date`,
      [Number(reservation.units), reservation.day_utc],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Release reserved (not consumed) volume for a campaign when it is confirmed
 * that no provider submission occurred for those reservations.
 */
export async function releaseDailyReservationsForCampaign(
  campaignId: string,
  confirmedNoProviderSubmission: boolean,
): Promise<number> {
  if (!confirmedNoProviderSubmission) return 0;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<{ id: string; day_utc: string; units: string }>(
      `SELECT id, day_utc::text, units::int AS units
         FROM daily_volume_reservations
        WHERE campaign_id = $1 AND status = 'reserved'
        FOR UPDATE`,
      [campaignId],
    );
    let released = 0;
    const byDay = new Map<string, number>();
    for (const row of rows.rows) {
      await client.query(
        `UPDATE daily_volume_reservations SET status = 'released', updated_at = NOW() WHERE id = $1`,
        [row.id],
      );
      byDay.set(row.day_utc, (byDay.get(row.day_utc) ?? 0) + Number(row.units));
      released += 1;
    }
    for (const [dayUtc, units] of byDay) {
      await client.query(
        `UPDATE daily_volume_counters
            SET reserved_units = GREATEST(0, reserved_units - $1), updated_at = NOW()
          WHERE day_utc = $2::date`,
        [units, dayUtc],
      );
    }
    await client.query("COMMIT");
    return released;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function usedDailyVolume(now = new Date()): Promise<number> {
  const dayUtc = utcDayString(now);
  const result = await query<{ reserved_units: string }>(
    `SELECT reserved_units::int AS reserved_units FROM daily_volume_counters WHERE day_utc = $1::date`,
    [dayUtc],
  );
  if (result.rows[0]) return Number(result.rows[0].reserved_units);
  // Fallback for environments before counters exist: count consumed/reserved messages including unsubscribed.
  const fallback = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM messages
      WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date
        AND status IN (
          'captured','submitted','submission_unknown','delivered','delayed',
          'bounced','complained','failed','suppressed','unsubscribed'
        )`,
    [dayUtc],
  );
  return Number(fallback.rows[0]?.count ?? 0);
}
