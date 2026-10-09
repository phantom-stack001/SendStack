import { getPool } from "./db";
import { makeId, normalizeEmail } from "./ids";

export type ContactStatus = "active" | "suppressed";

export function isSendableContactStatus(status: string): boolean {
  return status === "active";
}

/** New contacts are sendable unless the address is already suppressed. */
export function importContactStatus(isSuppressed: boolean): ContactStatus {
  return isSuppressed ? "suppressed" : "active";
}

/**
 * Update contact email, list, and optional status. Names are not collected on
 * entry and are left unchanged. Suppression on the new address wins.
 */
export async function updateContact(input: {
  contactId: string;
  actorUserId: string;
  email: string;
  status?: "active" | "suppressed";
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

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{
      id: string;
      email: string;
      status: string;
      consent_source: string;
    }>(`SELECT id, email, status, consent_source FROM contacts WHERE id = $1 FOR UPDATE`, [
      input.contactId,
    ]);
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
    } else if (input.status === "suppressed") {
      nextStatus = "suppressed";
    } else if (input.status === "active") {
      nextStatus = "active";
    } else if (row.status === "suppressed") {
      nextStatus = "suppressed";
    } else {
      nextStatus = "active";
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
              status = $2,
              updated_at = NOW()
        WHERE id = $3
        RETURNING id, email, first_name, last_name, status, consent_source, created_at`,
      [email, nextStatus, input.contactId],
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
       VALUES ($1, 'contact_updated', 'contact', $2, $3, NOW())`,
      [
        input.actorUserId,
        input.contactId,
        JSON.stringify({
          previous_email: row.email,
          email,
          email_changed: emailChanged,
          previous_status: row.status,
          status: nextStatus,
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

/** @deprecated Prefer updateContact. Kept as an alias for older imports. */
export const updateContactEmailWithConsentReset = updateContact;

export async function createContact(input: {
  email: string;
  listId: string;
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
         (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
       VALUES ($1, $2, '', '', $3, 'manual', NOW(), NOW(), NOW())`,
      [id, email, status],
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

/** @deprecated Prefer createContact. */
export const createPendingContact = createContact;
