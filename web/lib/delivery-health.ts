import { query } from "./db";

export type DeliveryHealthSnapshot = {
  submitted: number;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  suppressed: number;
  unsubscribed: number;
  failed: number;
  webhook_events_received: number;
  webhook_events_processed: number;
  webhook_correlation_complete: boolean;
  suppression_sync_healthy: boolean;
  healthy: boolean;
  issues: string[];
};

export async function getDeliveryHealthSnapshot(): Promise<DeliveryHealthSnapshot> {
  const counts = await query<{
    submitted: string;
    delivered: string;
    delayed: string;
    bounced: string;
    complained: string;
    suppressed: string;
    unsubscribed: string;
    failed: string;
  }>(`SELECT
      COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted,
      COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE status = 'delayed')::int AS delayed,
      COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced,
      COUNT(*) FILTER (WHERE status = 'complained')::int AS complained,
      COUNT(*) FILTER (WHERE status = 'suppressed')::int AS suppressed,
      COUNT(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM messages
     WHERE created_at >= NOW() - INTERVAL '7 days'`);

  const webhooks = await query<{ received: string; processed: string }>(
    `SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed
       FROM provider_events
      WHERE created_at >= NOW() - INTERVAL '7 days'`,
  );

  const uncorrelated = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM messages
      WHERE status = 'submitted'
        AND provider_id IS NOT NULL
        AND created_at < NOW() - INTERVAL '2 hours'
        AND created_at >= NOW() - INTERVAL '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM provider_events pe
           WHERE pe.payload_json ILIKE '%' || messages.provider_id || '%'
        )`,
  );

  const suppressionLag = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM provider_events
      WHERE processed_at IS NULL
        AND event_type IN (
          'email.bounced', 'email.complained', 'email.suppressed', 'contact.updated'
        )
        AND created_at >= NOW() - INTERVAL '7 days'`,
  );

  const row = counts.rows[0];
  const received = Number(webhooks.rows[0]?.received ?? 0);
  const processed = Number(webhooks.rows[0]?.processed ?? 0);
  const uncorrelatedCount = Number(uncorrelated.rows[0]?.count ?? 0);
  const suppressionLagCount = Number(suppressionLag.rows[0]?.count ?? 0);

  const issues: string[] = [];
  const webhookCorrelationComplete = uncorrelatedCount === 0;
  const suppressionSyncHealthy = suppressionLagCount === 0;

  if (!webhookCorrelationComplete) {
    issues.push(`${uncorrelatedCount} submitted message(s) lack matching webhook correlation.`);
  }
  if (!suppressionSyncHealthy) {
    issues.push(`${suppressionLagCount} suppression-related webhook event(s) are still unprocessed.`);
  }
  if (received > 0 && processed < received) {
    issues.push("Some provider webhook events have not finished processing.");
  }

  const healthy = issues.length === 0;

  return {
    submitted: Number(row?.submitted ?? 0),
    delivered: Number(row?.delivered ?? 0),
    delayed: Number(row?.delayed ?? 0),
    bounced: Number(row?.bounced ?? 0),
    complained: Number(row?.complained ?? 0),
    suppressed: Number(row?.suppressed ?? 0),
    unsubscribed: Number(row?.unsubscribed ?? 0),
    failed: Number(row?.failed ?? 0),
    webhook_events_received: received,
    webhook_events_processed: processed,
    webhook_correlation_complete: webhookCorrelationComplete,
    suppression_sync_healthy: suppressionSyncHealthy,
    healthy,
    issues,
  };
}
