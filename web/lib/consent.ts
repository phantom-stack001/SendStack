import { getPool } from "./db";
import { makeId, normalizeEmail } from "./ids";

export type ContactStatus = "active" | "suppressed" | "pending_consent";

export function isSendableContactStatus(status: string): boolean {
  return status === "active";
}

/** CSV/manual imports always land as pending_consent unless already suppressed. */
export function importContactStatus(isSuppressed: boolean): ContactStatus {
  return isSuppressed ? "suppressed" : "pending_consent";
}

export type ActivationInput = {
  contactId: string;
  actorUserId: string;
  consentSource: string;
  consentEvidence: string;
};

/**
 * Administrator-only activation with suppressions winning inside one transaction.
 * Writes a single audit_events row (contact_consent_activated).
 */
export async function activateContactWithConsent(input: ActivationInput): Promise<{
  status: ContactStatus;
  activated: boolean;
}> {
  const source = input.consentSource.trim();
  const evidence = input.consentEvidence.trim();
  if (source.length < 3) {
    throw new Error("Consent source must describe how permission was obtained.");
  }
  if (evidence.length < 20) {
    throw new Error("Consent evidence/attestation must be at least 20 characters.");
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const contact = await client.query<{ id: string; email: string; status: string }>(
      `SELECT id, email, status FROM contacts WHERE id = $1 FOR UPDATE`,
      [input.contactId],
    );
    const row = contact.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new Error("Contact not found.");
    }

    const email = normalizeEmail(row.email);
    const suppression = await client.query<{ email: string; protected: boolean }>(
      `SELECT email, COALESCE(protected, FALSE) AS protected
         FROM suppressions WHERE email = $1 FOR UPDATE`,
      [email],
    );

    let status: ContactStatus;
    let activated: boolean;

    if (suppression.rows[0]?.protected) {
      // Protected suppressions refuse activation; status stays suppressed.
      status = "suppressed";
      activated = false;
      if (row.status !== "suppressed") {
        await client.query(
          `UPDATE contacts SET status = 'suppressed', updated_at = NOW() WHERE id = $1`,
          [input.contactId],
        );
      }
    } else if (suppression.rows[0]) {
      await client.query(
        `UPDATE contacts
            SET status = 'suppressed',
                consent_source = $1,
                consent_evidence = $2,
                consent_attested_by = $3,
                consent_verified_at = NOW(),
                consent_at = COALESCE(consent_at, NOW()),
                updated_at = NOW()
          WHERE id = $4`,
        [source, evidence, input.actorUserId, input.contactId],
      );
      status = "suppressed";
      activated = false;
    } else {
      // Conditional update so a concurrent suppression insert wins the race.
      const activatedRow = await client.query<{ id: string }>(
        `UPDATE contacts
            SET status = 'active',
                consent_source = $1,
                consent_evidence = $2,
                consent_attested_by = $3,
                consent_verified_at = NOW(),
                consent_at = NOW(),
                updated_at = NOW()
          WHERE id = $4
            AND NOT EXISTS (
              SELECT 1 FROM suppressions s WHERE s.email = contacts.email
            )
          RETURNING id`,
        [source, evidence, input.actorUserId, input.contactId],
      );
      if (activatedRow.rows[0]) {
        status = "active";
        activated = true;
      } else {
        await client.query(
          `UPDATE contacts
              SET status = 'suppressed',
                  consent_source = $1,
                  consent_evidence = $2,
                  consent_attested_by = $3,
                  consent_verified_at = NOW(),
                  consent_at = COALESCE(consent_at, NOW()),
                  updated_at = NOW()
            WHERE id = $4`,
          [source, evidence, input.actorUserId, input.contactId],
        );
        status = "suppressed";
        activated = false;
      }
    }

    await client.query(
      `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
       VALUES ($1, 'contact_consent_activated', 'contact', $2, $3, NOW())`,
      [
        input.actorUserId,
        input.contactId,
        JSON.stringify({
          status,
          activated,
          consent_source: source,
          protected_suppression: Boolean(suppression.rows[0]?.protected),
          had_suppression: Boolean(suppression.rows[0]),
        }),
      ],
    );

    await client.query("COMMIT");
    return { status, activated };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Changing a contact email atomically demotes to pending_consent, clears prior-address
 * consent evidence, applies suppression checks, and writes one audit event.
 */
export async function updateContactEmailWithConsentReset(input: {
  contactId: string;
  actorUserId: string;
  email: string;
  firstName: string;
  lastName: string;
  consentSource: string;
  status?: "pending_consent" | "suppressed";
  listId?: string | null;
}): Promise<{
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  status: ContactStatus;
  consent_source: string;
  created_at: string;
}> {
  const email = normalizeEmail(input.email);
  const consentSource = input.consentSource.trim();
  if (!consentSource) throw new Error("Consent source is required.");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{
      id: string;
      email: string;
      status: string;
    }>(`SELECT id, email, status FROM contacts WHERE id = $1 FOR UPDATE`, [input.contactId]);
    const row = existing.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("Contact not found."), { status: 404 });
    }

    const conflict = await client.query(`SELECT id FROM contacts WHERE email = $1 AND id <> $2`, [
      email,
      input.contactId,
    ]);
    if (conflict.rows[0]) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("That email address already exists."), { status: 409 });
    }

    if (input.listId) {
      const list = await client.query(`SELECT id FROM lists WHERE id = $1`, [input.listId]);
      if (!list.rows[0]) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("The selected list does not exist."), { status: 400 });
      }
    }

    const suppression = await client.query<{ email: string }>(
      `SELECT email FROM suppressions WHERE email = $1 FOR UPDATE`,
      [email],
    );

    const emailChanged = normalizeEmail(row.email) !== email;
    let nextStatus: ContactStatus;
    if (suppression.rows[0]) {
      nextStatus = "suppressed";
    } else if (emailChanged) {
      // Prior-address consent evidence is not transferable.
      nextStatus = "pending_consent";
    } else if (input.status === "suppressed") {
      nextStatus = "suppressed";
    } else if (input.status === "pending_consent") {
      nextStatus = "pending_consent";
    } else {
      nextStatus = row.status === "suppressed" ? "suppressed" : (row.status as ContactStatus);
      if (nextStatus === "active" && emailChanged) nextStatus = "pending_consent";
    }

    const updated = await client.query<{
      id: string;
      email: string;
      first_name: string;
      last_name: string;
      status: ContactStatus;
      consent_source: string;
      created_at: string;
    }>(
      `UPDATE contacts
          SET email = $1,
              first_name = $2,
              last_name = $3,
              status = $4,
              consent_source = $5,
              consent_evidence = CASE WHEN $6::boolean THEN NULL ELSE consent_evidence END,
              consent_attested_by = CASE WHEN $6::boolean THEN NULL ELSE consent_attested_by END,
              consent_verified_at = CASE WHEN $6::boolean THEN NULL ELSE consent_verified_at END,
              updated_at = NOW()
        WHERE id = $7
        RETURNING id, email, first_name, last_name, status, consent_source, created_at`,
      [
        email,
        input.firstName.trim(),
        input.lastName.trim(),
        nextStatus,
        consentSource,
        emailChanged,
        input.contactId,
      ],
    );

    if (input.listId) {
      await client.query(`DELETE FROM list_contacts WHERE contact_id = $1`, [input.contactId]);
      await client.query(
        `INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`,
        [input.listId, input.contactId],
      );
    }

    await client.query(
      `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
       VALUES ($1, 'contact_email_changed', 'contact', $2, $3, NOW())`,
      [
        input.actorUserId,
        input.contactId,
        JSON.stringify({
          previous_email: row.email,
          email,
          email_changed: emailChanged,
          previous_status: row.status,
          status: nextStatus,
          consent_cleared: emailChanged,
          suppressed: Boolean(suppression.rows[0]),
          list_id: input.listId ?? null,
        }),
      ],
    );

    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createPendingContact(input: {
  email: string;
  firstName: string;
  lastName: string;
  listId: string;
  consentSource: string;
}): Promise<{ id: string; status: ContactStatus }> {
  const email = normalizeEmail(input.email);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const suppressed = await client.query(`SELECT 1 FROM suppressions WHERE email = $1`, [email]);
    const status = importContactStatus(Boolean(suppressed.rows[0]));
    const id = makeId("con");
    await client.query(
      `INSERT INTO contacts
         (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at, consent_evidence)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW(), NULL)`,
      [id, email, input.firstName, input.lastName, status, input.consentSource.trim() || "manual"],
    );
    await client.query(`INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`, [
      input.listId,
      id,
    ]);
    await client.query("COMMIT");
    return { id, status };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
