import { query } from "./db";
import { normalizeEmail } from "./ids";

export type SuppressionReason =
  | "unsubscribe"
  | "hard_bounce"
  | "complaint"
  | "manual"
  | "provider_suppression";

/** Reasons that must never be diluted by weaker later events. */
const PROTECTED_REASONS = new Set<SuppressionReason>([
  "complaint",
  "hard_bounce",
  "unsubscribe",
  "provider_suppression",
]);

export async function applySuppression(
  email: string,
  reason: SuppressionReason,
  source = "application",
): Promise<void> {
  const normalized = normalizeEmail(email);
  const existing = await query<{ reason: SuppressionReason }>(
    `SELECT reason FROM suppressions WHERE email = $1`,
    [normalized],
  );
  const current = existing.rows[0]?.reason;
  if (current && PROTECTED_REASONS.has(current) && reason === "manual") {
    // Keep stronger provider/compliance reasons.
    await query(`UPDATE contacts SET status = 'suppressed', updated_at = NOW() WHERE email = $1`, [normalized]);
    return;
  }
  if (current === "complaint" && reason !== "complaint") {
    await query(`UPDATE contacts SET status = 'suppressed', updated_at = NOW() WHERE email = $1`, [normalized]);
    return;
  }

  await query(
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
  await query(`UPDATE contacts SET status = 'suppressed', updated_at = NOW() WHERE email = $1`, [normalized]);
}

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const result = await query(`SELECT 1 FROM suppressions WHERE email = $1`, [normalizeEmail(email)]);
  return Boolean(result.rows[0]);
}

/**
 * Explicit re-consent removal. Does not call the provider to re-subscribe contacts.
 * Requires an audited consent note from an administrator.
 */
export async function removeSuppressionWithReconsent(input: {
  email: string;
  actorUserId: string;
  consentNote: string;
}): Promise<{ removed: boolean }> {
  const email = normalizeEmail(input.email);
  const note = input.consentNote.trim();
  if (note.length < 12) {
    throw new Error("Re-consent note must explain the explicit permission (at least 12 characters).");
  }
  const deleted = await query(`DELETE FROM suppressions WHERE email = $1 RETURNING email, reason, source`, [email]);
  if (!deleted.rows[0]) {
    return { removed: false };
  }
  await query(
    `UPDATE contacts SET status = 'active', updated_at = NOW() WHERE email = $1`,
    [email],
  );
  await query(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
     VALUES ($1, 'suppression_reconsent_removed', 'suppression', $2, $3, NOW())`,
    [
      input.actorUserId,
      email,
      JSON.stringify({
        previous_reason: deleted.rows[0].reason,
        previous_source: deleted.rows[0].source,
        consent_note: note,
        provider_reactivation: false,
      }),
    ],
  );
  return { removed: true };
}
