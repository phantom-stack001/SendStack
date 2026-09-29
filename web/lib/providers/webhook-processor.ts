import { getPool, query } from "../db";
import {
  messageStatusRank,
  recipientStatusFromMessageStatus,
  RECIPIENT_STATUS_RANK,
  statusFromResendEvent,
  TERMINAL_MESSAGE_STATUSES,
  TERMINAL_RECIPIENT_STATUSES,
} from "../delivery-status";
import { makeId, normalizeEmail } from "../ids";
import { applySuppression, type SuppressionReason } from "../suppressions";
import { reconcileCampaignAfterCancel } from "../launch-jobs";

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
    /** Resend/SES bounce classification; absent on older or partial payloads. */
    bounce?: {
      type?: string;
      subType?: string;
      sub_type?: string;
      message?: string;
    };
  };
};

/**
 * Only a permanent bounce justifies a protected, permanent suppression.
 *
 * A transient bounce (full mailbox, greylisting, throttling) must not destroy a
 * legitimate subscriber: protected suppressions cannot be cleared by re-consent or
 * by the removal APIs, so treating a soft bounce as hard is unrecoverable in-app.
 * A missing classification is treated as permanent, which protects sending
 * reputation rather than continuing to mail an address that may be dead.
 */
export function isPermanentBounce(event: ResendWebhookEvent): boolean {
  const raw = (event.data?.bounce?.type ?? "").trim().toLowerCase();
  if (!raw) return true;
  if (raw === "transient" || raw === "soft" || raw === "undetermined") return false;
  return true;
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
  retryable?: boolean;
};

/**
 * Claim a provider event, apply all required effects, and set processed_at only on success.
 * Failures leave the event unprocessed and retryable (claim cleared with token check).
 */
export async function processResendWebhookEvent(
  eventId: string,
  event: ResendWebhookEvent,
  rawBody: string,
  claimOwner = makeId("wco"),
): Promise<ProcessWebhookResult> {
  const claimToken = makeId("wct");
  const pool = getPool();
  const client = await pool.connect();
  let campaignId: string | null = null;

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO provider_events (id, provider, event_type, payload_json, created_at, processed_at)
       VALUES ($1, 'resend', $2, $3, NOW(), NULL)
       ON CONFLICT (id) DO NOTHING`,
      [eventId, event.type ?? "unknown", rawBody],
    );

    const claimResult = await client.query<{ id: string }>(
      `UPDATE provider_events
          SET claim_owner = $2,
              claim_token = $3,
              claim_expires_at = NOW() + INTERVAL '2 minutes',
              processing_started_at = COALESCE(processing_started_at, NOW())
        WHERE id = $1
          AND processed_at IS NULL
          AND (claim_token IS NULL OR claim_expires_at < NOW())
        RETURNING id`,
      [eventId, claimOwner, claimToken],
    );

    if (!claimResult.rows[0]) {
      const existing = await client.query<{ processed_at: string | null }>(
        `SELECT processed_at FROM provider_events WHERE id = $1`,
        [eventId],
      );
      await client.query("COMMIT");
      if (existing.rows[0]?.processed_at) {
        return { duplicate: true, processed: true, campaignId: null };
      }
      return { duplicate: false, processed: false, retryable: true, campaignId: null };
    }
    const providerId = event.data?.email_id;
    const recipients = recipientsFromEvent(event);

    if (providerId) {
      const linked = await client.query<{ campaign_id: string | null }>(
        `SELECT campaign_id FROM messages WHERE provider_id = $1 LIMIT 1`,
        [providerId],
      );
      campaignId = linked.rows[0]?.campaign_id ?? null;
    }
    if (!campaignId && event.data?.broadcast_id) {
      const linked = await client.query<{ id: string }>(
        `SELECT id FROM campaigns WHERE provider_broadcast_id = $1 LIMIT 1`,
        [event.data.broadcast_id],
      );
      campaignId = linked.rows[0]?.id ?? null;
    }

    await client.query(
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

    if (providerId && campaignId) {
      for (const email of recipients) {
        await client.query(
          `UPDATE campaign_recipients
              SET provider_email_id = COALESCE(provider_email_id, $1)
            WHERE campaign_id = $2 AND lower(email) = $3`,
          [providerId, campaignId, email],
        );
        await client.query(
          `UPDATE messages
              SET provider_id = COALESCE(provider_id, $1)
            WHERE campaign_id = $2 AND lower(to_email) = $3 AND provider_id IS NULL`,
          [providerId, campaignId, email],
        );
      }
    }

    const isBroadcastUnsubscribe =
      event.type === "email.unsubscribed" ||
      (event.type === "contact.updated" && event.data?.unsubscribed === true);

    if (isBroadcastUnsubscribe) {
      const email = event.data?.email ? normalizeEmail(event.data.email) : recipients[0];
      if (email) {
        await applySuppression(email, "unsubscribe", "resend_webhook", client);
        // Only update the matched message/campaign — never rewrite unrelated history.
        await applyMonotonicUpdates(client, {
          providerId,
          nextMessageStatus: "unsubscribed",
          nextRecipientStatus: "suppressed",
          recipients: [email],
          campaignId,
          diagnostics: { event_type: event.type, event_id: eventId },
          emailScopedWithoutProvider: false,
        });
      }
    } else {
      const derived = statusFromResendEvent(event.type);
      if (derived) {
        let suppressionReason: SuppressionReason | null = null;
        // A transient bounce still records the bounced message state below, but must
        // not create a permanent protected suppression.
        if (derived === "bounced" && isPermanentBounce(event)) suppressionReason = "hard_bounce";
        if (derived === "complained") suppressionReason = "complaint";
        if (derived === "suppressed") suppressionReason = "provider_suppression";
        if (derived === "unsubscribed") suppressionReason = "unsubscribe";
        if (suppressionReason) {
          for (const email of recipients) {
            await applySuppression(email, suppressionReason, "resend_webhook", client);
          }
        }
        await applyMonotonicUpdates(client, {
          providerId,
          nextMessageStatus: derived,
          nextRecipientStatus: recipientStatusFromMessageStatus(derived),
          recipients,
          campaignId,
          diagnostics: {
            event_type: event.type,
            event_id: eventId,
            broadcast_id: event.data?.broadcast_id ?? null,
          },
          emailScopedWithoutProvider: !providerId && Boolean(campaignId),
        });
      }
    }

    if (campaignId) {
      await maybeCompleteCampaign(client, campaignId);
      const cancelState = await client.query<{ status: string }>(
        `SELECT status FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      if (
        cancelState.rows[0] &&
        ["cancel_requested", "cancelled", "partially_sent"].includes(cancelState.rows[0].status)
      ) {
        await reconcileCampaignAfterCancel(campaignId, client);
      }
    }

    // processed_at only after all required effects succeed; unique claim token required.
    const completed = await client.query<{ id: string }>(
      `UPDATE provider_events
          SET processed_at = NOW(),
              claim_owner = NULL,
              claim_expires_at = NULL,
              claim_token = NULL,
              resolved_at = NOW()
        WHERE id = $1
          AND claim_token = $2
          AND processed_at IS NULL
        RETURNING id`,
      [eventId, claimToken],
    );
    if (!completed.rows[0]) {
      const existing = await client.query<{ processed_at: string | null }>(
        `SELECT processed_at FROM provider_events WHERE id = $1`,
        [eventId],
      );
      if (existing.rows[0]?.processed_at) {
        return { duplicate: true, processed: true, campaignId };
      }
      throw new Error("Webhook claim token mismatch while completing event.");
    }

    await client.query("COMMIT");
    return { duplicate: false, processed: true, campaignId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Atomic monotonic updates using status ranks / terminal predicates.
 * Does not rewrite unrelated historical messages for contact-level unsubscribes.
 */
async function applyMonotonicUpdates(client: { query: typeof query }, input: {
  providerId?: string;
  nextMessageStatus: string;
  nextRecipientStatus: string | null;
  recipients: string[];
  campaignId: string | null;
  diagnostics: Record<string, unknown>;
  emailScopedWithoutProvider?: boolean;
}): Promise<void> {
  const nextMsgRank = messageStatusRank(input.nextMessageStatus);
  const nextRcptRank = input.nextRecipientStatus
    ? (RECIPIENT_STATUS_RANK[input.nextRecipientStatus] ?? 0)
    : 0;
  const diag = JSON.stringify(input.diagnostics);
  const terminalMsgList = [...TERMINAL_MESSAGE_STATUSES];
  const terminalRcptList = [...TERMINAL_RECIPIENT_STATUSES];

  if (input.providerId) {
    await client.query(
      `UPDATE messages
          SET status = $1,
              status_rank = $2,
              delivered_at = CASE WHEN $1 = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
              diagnostic_json = $3
        WHERE provider_id = $4
          AND (
            status <> ALL($5::text[])
            OR ($1 = 'complained' AND status = 'bounced')
          )
          AND $2 >= status_rank`,
      [input.nextMessageStatus, nextMsgRank, diag, input.providerId, terminalMsgList],
    );

    if (input.nextRecipientStatus) {
      const isTerminalNext = TERMINAL_RECIPIENT_STATUSES.has(input.nextRecipientStatus);
      await client.query(
        `UPDATE campaign_recipients
            SET status = $1,
                sent_at = CASE WHEN $1 IN ('sent', 'delayed') THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
                provider_email_id = COALESCE(provider_email_id, $2)
          WHERE (
              provider_email_id = $2
              OR message_id IN (SELECT id FROM messages WHERE provider_id = $2)
            )
            AND (
              status <> ALL($3::text[])
              OR ($1 = 'complained' AND status = 'bounced')
            )
            AND (
              $4::boolean
              OR status IN ('cancel_requested', 'outcome_pending')
              OR (
                CASE status
                  WHEN 'queued' THEN 10
                  WHEN 'processing' THEN 20
                  WHEN 'submission_unknown' THEN 25
                  WHEN 'cancel_requested' THEN 28
                  WHEN 'outcome_pending' THEN 29
                  WHEN 'delayed' THEN 35
                  WHEN 'sent' THEN 40
                  WHEN 'bounced' THEN 100
                  ELSE 0
                END
              ) <= $5
            )`,
        [
          input.nextRecipientStatus,
          input.providerId,
          terminalRcptList,
          isTerminalNext,
          nextRcptRank,
        ],
      );
    }
  }

  // Campaign-scoped email updates only when no provider id (never a global 30-day rewrite).
  if (input.emailScopedWithoutProvider && input.campaignId && input.recipients.length) {
    for (const email of input.recipients) {
      await client.query(
        `UPDATE messages
            SET status = $1,
                status_rank = $2,
                diagnostic_json = $3
          WHERE campaign_id = $4
            AND lower(to_email) = $5
            AND (
              status <> ALL($6::text[])
              OR ($1 = 'complained' AND status = 'bounced')
            )
            AND $2 >= status_rank`,
        [input.nextMessageStatus, nextMsgRank, diag, input.campaignId, email, terminalMsgList],
      );
      if (input.nextRecipientStatus) {
        const isTerminalNext = TERMINAL_RECIPIENT_STATUSES.has(input.nextRecipientStatus);
        await client.query(
          `UPDATE campaign_recipients
              SET status = $1
            WHERE campaign_id = $2
              AND lower(email) = $3
              AND (
                status <> ALL($4::text[])
                OR ($1 = 'complained' AND status = 'bounced')
              )
              AND (
                $5::boolean
                OR status IN ('cancel_requested', 'outcome_pending')
                OR (
                  CASE status
                    WHEN 'queued' THEN 10
                    WHEN 'processing' THEN 20
                    WHEN 'submission_unknown' THEN 25
                    WHEN 'cancel_requested' THEN 28
                    WHEN 'outcome_pending' THEN 29
                    WHEN 'delayed' THEN 35
                    WHEN 'sent' THEN 40
                    WHEN 'bounced' THEN 100
                    ELSE 0
                  END
                ) <= $6
              )`,
          [
            input.nextRecipientStatus,
            input.campaignId,
            email,
            terminalRcptList,
            isTerminalNext,
            nextRcptRank,
          ],
        );
      }
    }
  }
}

async function maybeCompleteCampaign(client: { query: typeof query }, campaignId: string): Promise<void> {
  await client.query(
    `UPDATE campaigns
        SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE id = $1
        AND status IN ('sending', 'reconciling', 'submission_unknown')
        AND EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.campaign_id = campaigns.id)
        AND NOT EXISTS (
          SELECT 1 FROM campaign_recipients cr
           WHERE cr.campaign_id = campaigns.id
             AND cr.status IN ('queued', 'processing', 'delayed', 'submission_unknown', 'cancel_requested', 'outcome_pending')
        )`,
    [campaignId],
  );
}

export { canTransitionMessageStatus, canTransitionRecipientStatus } from "../delivery-status";
