import type { PoolClient } from "pg";
import { getPool } from "./db";
import { normalizeEmail } from "./ids";

export type SuppressionReason =
  | "unsubscribe"
  | "hard_bounce"
  | "complaint"
  | "manual"
  | "provider_suppression";

const PROTECTED_REASONS = new Set<SuppressionReason>([
  "complaint",
  "hard_bounce",
  "unsubscribe",
  "provider_suppression",
]);

const COLUMN_PROTECTED_REASONS = new Set<SuppressionReason>([
  "hard_bounce",
  "complaint",
  "provider_suppression",
]);

async function suppressionsHaveProtectedColumn(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_name = 'suppressions' AND column_name = 'protected'
      LIMIT 1`,
  );
  return Boolean(result.rows[0]);
}

export async function applySuppression(
  email: string,
  reason: SuppressionReason,
  source = "application",
  external?: PoolClient,
): Promise<void> {
  const normalized = normalizeEmail(email);
  const client = external ?? (await getPool().connect());
  const ownTransaction = !external;
  try {
    if (ownTransaction) await client.query("BEGIN");
    const { lockSubmitBarrier } = await import("./submit-barrier");
    await lockSubmitBarrier(client);
    const hasProtected = await suppressionsHaveProtectedColumn(client);
    const existing = await client.query<{ reason: SuppressionReason; protected?: boolean }>(
      hasProtected
        ? `SELECT reason, protected FROM suppressions WHERE email = $1 FOR UPDATE`
        : `SELECT reason FROM suppressions WHERE email = $1 FOR UPDATE`,
      [normalized],
    );
    const current = existing.rows[0]?.reason;
    if (current && PROTECTED_REASONS.has(current) && reason === "manual") {
      await client.query(`UPDATE contacts SET status = 'suppressed', updated_at = NOW() WHERE email = $1`, [
        normalized,
      ]);
      if (ownTransaction) await client.query("COMMIT");
      return;
    }
    if (current === "complaint" && reason !== "complaint") {
      await client.query(`UPDATE contacts SET status = 'suppressed', updated_at = NOW() WHERE email = $1`, [
        normalized,
      ]);
      if (ownTransaction) await client.query("COMMIT");
      return;
    }

    const setProtected = COLUMN_PROTECTED_REASONS.has(reason);
    if (hasProtected) {
      await client.query(
        `INSERT INTO suppressions (email, reason, source, protected, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (email) DO UPDATE SET
           reason = CASE
             WHEN suppressions.reason = 'complaint' THEN suppressions.reason
             WHEN suppressions.reason = 'hard_bounce' AND EXCLUDED.reason NOT IN ('complaint') THEN suppressions.reason
             WHEN suppressions.reason IN ('unsubscribe', 'provider_suppression')
                  AND EXCLUDED.reason NOT IN ('complaint', 'hard_bounce') THEN suppressions.reason
             ELSE EXCLUDED.reason
           END,
           source = CASE
             WHEN suppressions.reason = 'complaint' THEN suppressions.source
             ELSE EXCLUDED.source
           END,
           protected = CASE
             WHEN suppressions.protected IS TRUE THEN TRUE
             WHEN EXCLUDED.protected IS TRUE THEN TRUE
             ELSE FALSE
           END`,
        [normalized, reason, source, setProtected],
      );
    } else {
      await client.query(
        `INSERT INTO suppressions (email, reason, source, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (email) DO UPDATE SET
           reason = CASE
             WHEN suppressions.reason = 'complaint' THEN suppressions.reason
             WHEN suppressions.reason = 'hard_bounce' AND EXCLUDED.reason NOT IN ('complaint') THEN suppressions.reason
             WHEN suppressions.reason IN ('unsubscribe', 'provider_suppression')
                  AND EXCLUDED.reason NOT IN ('complaint', 'hard_bounce') THEN suppressions.reason
             ELSE EXCLUDED.reason
           END,
           source = CASE
             WHEN suppressions.reason = 'complaint' THEN suppressions.source
             ELSE EXCLUDED.source
           END`,
        [normalized, reason, source],
      );
    }
    await client.query(`UPDATE contacts SET status = 'suppressed', updated_at = NOW() WHERE email = $1`, [
      normalized,
    ]);
    if (ownTransaction) await client.query("COMMIT");
  } catch (error) {
    if (ownTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (ownTransaction) client.release();
  }
}

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const { query } = await import("./db");
  const result = await query(`SELECT 1 FROM suppressions WHERE email = $1`, [normalizeEmail(email)]);
  return Boolean(result.rows[0]);
}

/**
 * Remove a non-protected suppression and restore matching contacts to active.
 * Refuses protected suppressions (bounce/complaint/provider). Caller must not
 * write a second audit row when actorUserId is provided.
 */
export async function removeSuppression(input: {
  email: string;
  actorUserId: string;
}): Promise<{ removed: boolean; previousReason?: string; previousSource?: string }> {
  const email = normalizeEmail(input.email);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hasProtected = await suppressionsHaveProtectedColumn(client);
    const existing = await client.query<{ email: string; reason: string; source: string; protected?: boolean }>(
      hasProtected
        ? `SELECT email, reason, source, protected FROM suppressions WHERE email = $1 FOR UPDATE`
        : `SELECT email, reason, source FROM suppressions WHERE email = $1 FOR UPDATE`,
      [email],
    );
    const row = existing.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { removed: false };
    }
    // Key the refusal on the reason as well as the column: on a database that has not
    // yet applied 0006 the `protected` column is absent, and gating only on the column
    // would allow a complaint or hard-bounce suppression to be deleted.
    if ((hasProtected && row.protected) || PROTECTED_REASONS.has(row.reason as SuppressionReason)) {
      await client.query("ROLLBACK");
      throw new Error("Protected suppressions (bounce/complaint/provider) cannot be removed.");
    }

    const deleted = await client.query<{ email: string; reason: string; source: string }>(
      `DELETE FROM suppressions WHERE email = $1 RETURNING email, reason, source`,
      [email],
    );
    await client.query(
      `UPDATE contacts
          SET status = 'active',
              updated_at = NOW()
        WHERE email = $1`,
      [email],
    );
    await client.query(
      `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
       VALUES ($1, 'suppression_removed', 'suppression', $2, $3, NOW())`,
      [
        input.actorUserId,
        email,
        JSON.stringify({
          previous_reason: deleted.rows[0].reason,
          previous_source: deleted.rows[0].source,
          provider_reactivation: false,
          resulting_status: "active",
        }),
      ],
    );
    await client.query("COMMIT");
    return {
      removed: true,
      previousReason: deleted.rows[0].reason,
      previousSource: deleted.rows[0].source,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** @deprecated Prefer removeSuppression. */
export const removeSuppressionWithReconsent = (
  input: { email: string; actorUserId: string; consentNote?: string },
) => removeSuppression({ email: input.email, actorUserId: input.actorUserId });
