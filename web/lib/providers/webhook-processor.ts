import { query } from "../db";
import {
  canTransitionMessageStatus,
  canTransitionRecipientStatus,
  recipientStatusFromMessageStatus,
  statusFromResendEvent,
} from "../delivery-status";
import { normalizeEmail } from "../ids";
import { applySuppression, type SuppressionReason } from "../suppressions";

export type ResendWebhookEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    created_at?: string;
    broadcast_id?: string;
    email?: string;
    unsubscribed?: boolean;
    bounce?: { type?: string; message?: string };
    tags?: Array<{ name?: string; value?: string }> | Record<string, string>;
  };
};

async function maybeCompleteCampaign(campaignId: string | null | undefined) {
  if (!campaignId) return;
  await query(
    `UPDATE campaigns
        SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE id = $1
        AND status = 'sending'
        AND EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.campaign_id = campaigns.id)
        AND NOT EXISTS (
          SELECT 1 FROM campaign_recipients cr
           WHERE cr.campaign_id = campaigns.id AND cr.status IN ('queued', 'processing', 'delayed')
        )`,
    [campaignId],
  );
}

async function resolveCampaignId(event: ResendWebhookEvent, providerId?: string): Promise<string | null> {
  if (providerId) {
    const linked = await query<{ campaign_id: string | null }>(
      `SELECT campaign_id FROM messages WHERE provider_id = $1 LIMIT 1`,
      [providerId],
    );
    if (linked.rows[0]?.campaign_id) return linked.rows[0].campaign_id;
  }
  if (event.data?.broadcast_id) {
    const linked = await query<{ id: string }>(
      `SELECT id FROM campaigns WHERE provider_broadcast_id = $1 LIMIT 1`,
      [event.data.broadcast_id],
    );
    if (linked.rows[0]?.id) return linked.rows[0].id;
  }
  return null;
}

async function updateMessageStatus(providerId: string, nextStatus: string, diagnostics: Record<string, unknown>) {
  const current = await query<{ id: string; status: string }>(
    `SELECT id, status FROM messages WHERE provider_id = $1`,
    [providerId],
  );
  for (const row of current.rows) {
    if (!canTransitionMessageStatus(row.status, nextStatus)) continue;
    await query(
      `UPDATE messages
          SET status = $1,
              delivered_at = CASE WHEN $1 = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
              diagnostic_json = $2
        WHERE id = $3`,
      [nextStatus, JSON.stringify(diagnostics), row.id],
    );
  }

  // Correlate broadcast recipients that were created before provider email IDs arrived.
  if (!current.rows.length) {
    return;
  }
}

async function updateRecipientStatus(providerId: string, nextStatus: string, recipientEmails: string[], campaignId: string | null) {
  const current = await query<{ id: string; status: string }>(
    `SELECT id, status FROM campaign_recipients
      WHERE provider_email_id = $1
         OR message_id IN (SELECT id FROM messages WHERE provider_id = $1)`,
    [providerId],
  );

  for (const row of current.rows) {
    if (!canTransitionRecipientStatus(row.status, nextStatus)) continue;
    await query(
      `UPDATE campaign_recipients
          SET status = $1,
              sent_at = CASE WHEN $1 IN ('sent', 'delayed') THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
              provider_email_id = COALESCE(provider_email_id, $2)
        WHERE id = $3`,
      [nextStatus, providerId, row.id],
    );
  }

  if (campaignId && recipientEmails.length) {
    for (const email of recipientEmails) {
      const rows = await query<{ id: string; status: string }>(
        `SELECT id, status FROM campaign_recipients
          WHERE campaign_id = $1 AND lower(email) = $2`,
        [campaignId, normalizeEmail(email)],
      );
      for (const row of rows.rows) {
        if (!canTransitionRecipientStatus(row.status, nextStatus)) continue;
        await query(
          `UPDATE campaign_recipients
              SET status = $1,
                  sent_at = CASE WHEN $1 IN ('sent', 'delayed') THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
                  provider_email_id = COALESCE(provider_email_id, $2)
            WHERE id = $3`,
          [nextStatus, providerId || null, row.id],
        );
      }
    }
  }
}

async function linkProviderEmailToRecipients(
  campaignId: string | null,
  providerId: string | undefined,
  recipientEmails: string[],
) {
  if (!campaignId || !providerId || !recipientEmails.length) return;
  for (const email of recipientEmails) {
    await query(
      `UPDATE campaign_recipients
          SET provider_email_id = COALESCE(provider_email_id, $1)
        WHERE campaign_id = $2 AND lower(email) = $3`,
      [providerId, campaignId, normalizeEmail(email)],
    );
    await query(
      `UPDATE messages
          SET provider_id = COALESCE(provider_id, $1)
        WHERE campaign_id = $2 AND lower(to_email) = $3 AND provider_id IS NULL`,
      [providerId, campaignId, normalizeEmail(email)],
    );
  }
}

function recipientsFromEvent(event: ResendWebhookEvent): string[] {
  const to = event.data?.to;
  if (Array.isArray(to)) return to.map(normalizeEmail);
  if (typeof to === "string" && to.trim()) return [normalizeEmail(to)];
  if (event.data?.email) return [normalizeEmail(event.data.email)];
  return [];
}

export type ProcessWebhookResult = {
  duplicate: boolean;
  processed: boolean;
  campaignId: string | null;
};

/**
 * Persist and process a verified Resend webhook. Duplicate event IDs are ignored entirely.
 */
export async function processResendWebhookEvent(
  eventId: string,
  event: ResendWebhookEvent,
  rawBody: string,
): Promise<ProcessWebhookResult> {
  const inserted = await query<{ id: string }>(
    `INSERT INTO provider_events (id, provider, event_type, payload_json, created_at, processed_at)
     VALUES ($1, 'resend', $2, $3, NOW(), NULL)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [eventId, event.type ?? "unknown", rawBody],
  );

  if (!inserted.rows[0]) {
    const existing = await query<{ processed_at: string | null }>(
      `SELECT processed_at FROM provider_events WHERE id = $1`,
      [eventId],
    );
    if (existing.rows[0]?.processed_at) {
      return { duplicate: true, processed: false, campaignId: null };
    }
    // Same event id arrived again before processing finished — continue safely.
  }

  const providerId = event.data?.email_id;
  const recipients = recipientsFromEvent(event);
  const campaignId = await resolveCampaignId(event, providerId);

  await query(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
     VALUES (NULL, $1, 'provider_event', $2, $3, NOW())`,
    [
      `resend_${event.type ?? "unknown"}`,
      providerId ?? eventId,
      JSON.stringify({
        provider: "resend",
        event_id: eventId,
        recipient_count: recipients.length,
        broadcast_id: event.data?.broadcast_id ?? null,
        campaign_id: campaignId,
      }),
    ],
  );

  await linkProviderEmailToRecipients(campaignId, providerId, recipients);

  if (event.type === "contact.updated") {
    const email = event.data?.email ? normalizeEmail(event.data.email) : recipients[0];
    if (email && event.data?.unsubscribed === true) {
      await applySuppression(email, "unsubscribe", "resend_webhook");
      if (providerId) {
        await updateMessageStatus(providerId, "unsubscribed", { event_type: event.type, event_id: eventId });
        await updateRecipientStatus(providerId, "suppressed", [email], campaignId);
      } else if (campaignId) {
        await updateRecipientStatus("", "suppressed", [email], campaignId);
      }
    }
  } else {
    const derived = statusFromResendEvent(event.type);
    if (derived) {
      let suppressionReason: SuppressionReason | null = null;
      if (derived === "bounced") suppressionReason = "hard_bounce";
      if (derived === "complained") suppressionReason = "complaint";
      if (derived === "suppressed") suppressionReason = "provider_suppression";
      if (derived === "unsubscribed") suppressionReason = "unsubscribe";

      if (suppressionReason) {
        for (const email of recipients) {
          await applySuppression(email, suppressionReason, "resend_webhook");
        }
      }

      if (providerId) {
        await updateMessageStatus(providerId, derived, {
          event_type: event.type,
          event_id: eventId,
          broadcast_id: event.data?.broadcast_id ?? null,
        });
        const recipientStatus = recipientStatusFromMessageStatus(derived);
        if (recipientStatus) {
          await updateRecipientStatus(providerId, recipientStatus, recipients, campaignId);
        }
      } else if (campaignId && recipients.length) {
        const recipientStatus = recipientStatusFromMessageStatus(derived);
        if (recipientStatus) {
          await updateRecipientStatus("", recipientStatus, recipients, campaignId);
        }
      }
    }
  }

  await maybeCompleteCampaign(campaignId);
  await query(`UPDATE provider_events SET processed_at = NOW() WHERE id = $1`, [eventId]);
  return { duplicate: false, processed: true, campaignId };
}

export { canTransitionMessageStatus, canTransitionRecipientStatus };
