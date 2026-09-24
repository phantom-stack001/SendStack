import { applySuppression } from "@/lib/suppressions";
import { query } from "@/lib/db";
import { isTimestampFresh, verifySvixSignature } from "@/lib/providers/webhook";

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
           WHERE cr.campaign_id = campaigns.id AND cr.status IN ('queued', 'processing')
        )`,
    [campaignId],
  );
}

export async function POST(request: Request) {
  const body = await request.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";
  const messageId = request.headers.get("svix-id") ?? "";
  const timestamp = request.headers.get("svix-timestamp") ?? "";
  const signatureHeader = request.headers.get("svix-signature") ?? "";
  if (!isTimestampFresh(timestamp, 300) || !verifySvixSignature(secret, body, messageId, timestamp, signatureHeader)) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  const event = JSON.parse(body) as {
    type?: string;
    data?: { email_id?: string; to?: string[] | string; created_at?: string; broadcast_id?: string };
  };
  const providerId = event.data?.email_id;
  const recipients = Array.isArray(event.data?.to) ? event.data.to : event.data?.to ? [event.data.to] : [];
  const eventId = messageId || `resend_${Date.now()}`;
  await query(
    `INSERT INTO provider_events (id, provider, event_type, payload_json, created_at, processed_at)
     VALUES ($1, 'resend', $2, $3, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
    [eventId, event.type ?? "unknown", body],
  );
  await query(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
     VALUES (NULL, $1, 'provider_event', $2, $3, NOW())`,
    [
      `resend_${event.type ?? "unknown"}`,
      providerId ?? eventId,
      JSON.stringify({ provider: "resend", event_id: eventId, recipient_count: recipients.length }),
    ],
  );

  let campaignId: string | null = null;
  if (providerId) {
    const linked = await query<{ campaign_id: string | null }>(
      `SELECT campaign_id FROM messages WHERE provider_id = $1 LIMIT 1`,
      [providerId],
    );
    campaignId = linked.rows[0]?.campaign_id ?? null;
  }
  if (!campaignId && event.data?.broadcast_id) {
    const linked = await query<{ id: string }>(
      `SELECT id FROM campaigns WHERE provider_broadcast_id = $1 LIMIT 1`,
      [event.data.broadcast_id],
    );
    campaignId = linked.rows[0]?.id ?? null;
  }

  if (providerId && event.type === "email.delivered") {
    await query(`UPDATE messages SET status = 'delivered', provider_id = $1, delivered_at = NOW() WHERE provider_id = $1`, [providerId]);
    await query(
      `UPDATE campaign_recipients SET status = 'sent', sent_at = COALESCE(sent_at, NOW())
        WHERE provider_email_id = $1 OR message_id IN (SELECT id FROM messages WHERE provider_id = $1)`,
      [providerId],
    );
  }
  if (event.type === "email.bounced" || event.type === "email.complained") {
    const reason = event.type === "email.bounced" ? "hard_bounce" : "complaint";
    const recipientStatus = reason === "complaint" ? "complained" : "bounced";
    for (const email of recipients) await applySuppression(email, reason, "resend_webhook");
    if (providerId) {
      await query(`UPDATE messages SET status = $1, provider_id = $2 WHERE provider_id = $2`, [recipientStatus, providerId]);
      await query(
        `UPDATE campaign_recipients SET status = $1
          WHERE provider_email_id = $2 OR message_id IN (SELECT id FROM messages WHERE provider_id = $2)`,
        [recipientStatus, providerId],
      );
    }
  }
  if (event.type === "email.sent" || event.type === "email.delivered") {
    if (providerId) {
      await query(
        `UPDATE campaign_recipients SET status = 'sent', sent_at = COALESCE(sent_at, NOW())
          WHERE provider_email_id = $1 OR message_id IN (SELECT id FROM messages WHERE provider_id = $1)`,
        [providerId],
      );
    }
  }
  await maybeCompleteCampaign(campaignId);
  return Response.json({ received: true });
}
