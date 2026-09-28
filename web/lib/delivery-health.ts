import { query } from "./db";
import { makeId } from "./ids";

export type DeliveryHealthThresholds = {
  minSample: number;
  maxBounceRate: number;
  maxComplaintRate: number;
  maxUnsubscribeRate: number;
  maxDelayRate: number;
  maxFailureRate: number;
  emergencyStop: boolean;
  configured: boolean;
};

function rateEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a ratio between 0 and 1.`);
  }
  return value;
}

export function loadDeliveryHealthThresholds(): DeliveryHealthThresholds {
  const minSampleRaw = process.env.SENDSTACK_HEALTH_MIN_SAMPLE?.trim();
  const minSample = minSampleRaw ? Number(minSampleRaw) : NaN;
  const maxBounceRate = rateEnv("SENDSTACK_HEALTH_MAX_BOUNCE_RATE");
  const maxComplaintRate = rateEnv("SENDSTACK_HEALTH_MAX_COMPLAINT_RATE");
  const maxUnsubscribeRate = rateEnv("SENDSTACK_HEALTH_MAX_UNSUBSCRIBE_RATE");
  const maxDelayRate = rateEnv("SENDSTACK_HEALTH_MAX_DELAY_RATE");
  const maxFailureRate = rateEnv("SENDSTACK_HEALTH_MAX_FAILURE_RATE");
  const emergencyStop = ["1", "true", "yes", "on"].includes(
    (process.env.SENDSTACK_EMERGENCY_STOP ?? "").trim().toLowerCase(),
  );

  const configured =
    Number.isFinite(minSample) &&
    minSample > 0 &&
    maxBounceRate !== null &&
    maxComplaintRate !== null &&
    maxUnsubscribeRate !== null &&
    maxDelayRate !== null &&
    maxFailureRate !== null;

  return {
    minSample: Number.isFinite(minSample) && minSample > 0 ? minSample : 0,
    maxBounceRate: maxBounceRate ?? 1,
    maxComplaintRate: maxComplaintRate ?? 1,
    maxUnsubscribeRate: maxUnsubscribeRate ?? 1,
    maxDelayRate: maxDelayRate ?? 1,
    maxFailureRate: maxFailureRate ?? 1,
    emergencyStop,
    configured,
  };
}

export type DeliveryHealthSnapshot = {
  submitted: number;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  suppressed: number;
  unsubscribed: number;
  failed: number;
  sample_size: number;
  bounce_rate: number;
  complaint_rate: number;
  unsubscribe_rate: number;
  delay_rate: number;
  failure_rate: number;
  webhook_events_received: number;
  webhook_events_processed: number;
  webhook_correlation_complete: boolean;
  suppression_sync_healthy: boolean;
  thresholds_configured: boolean;
  emergency_stop: boolean;
  healthy: boolean;
  launch_blocked: boolean;
  blocking_reasons: string[];
  issues: string[];
};

export type HealthSubmitContext = {
  jobId?: string | null;
  campaignId?: string | null;
};

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/** Record an open health block that cannot age healthy without explicit resolve/waiver. */
export async function recordDeliveryHealthBlock(input: {
  kind:
    | "unprocessed_webhook"
    | "submission_unknown"
    | "unresolved_launch_job"
    | "manual_review"
    | "stuck_captured"
    | "other";
  detail: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
}): Promise<string> {
  const id = makeId("dhb");
  await query(
    `INSERT INTO delivery_health_blocks
       (id, kind, detail, related_entity_type, related_entity_id, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      id,
      input.kind,
      input.detail.slice(0, 500),
      input.relatedEntityType ?? null,
      input.relatedEntityId ?? null,
    ],
  );
  return id;
}

export async function getDeliveryHealthSnapshot(
  context?: HealthSubmitContext,
): Promise<DeliveryHealthSnapshot> {
  const thresholds = loadDeliveryHealthThresholds();
  const ignoreJobId = context?.jobId ?? null;
  const ignoreCampaignId = context?.campaignId ?? null;

  // Rate sample: recent messages (7d) for delivered/delayed/failed/submitted.
  const counts = await query<{
    submitted: string;
    delivered: string;
    delayed: string;
    bounced: string;
    failed: string;
  }>(`SELECT
      COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted,
      COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE status = 'delayed')::int AS delayed,
      COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM messages
     WHERE created_at >= NOW() - INTERVAL '7 days'
       AND COALESCE(is_test, FALSE) = FALSE`);

  // Complaints / unsubscribes from durable event facts — not by rewriting unrelated messages.
  const durableSignals = await query<{ complained: string; unsubscribed: string; suppressed: string }>(
    `SELECT
        (SELECT COUNT(*)::int FROM suppressions
          WHERE reason = 'complaint'
            AND created_at >= NOW() - INTERVAL '7 days') AS complained,
        (SELECT COUNT(*)::int FROM suppressions
          WHERE reason = 'unsubscribe'
            AND created_at >= NOW() - INTERVAL '7 days') AS unsubscribed,
        (SELECT COUNT(*)::int FROM suppressions
          WHERE reason IN ('hard_bounce', 'provider_suppression', 'manual')
            AND created_at >= NOW() - INTERVAL '7 days') AS suppressed`,
  );

  const webhooks = await query<{ received: string; processed: string }>(
    `SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed
       FROM provider_events`,
  );

  const uncorrelated = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM messages
      WHERE status IN ('submitted', 'submission_unknown')
        AND provider_id IS NOT NULL
        AND created_at < NOW() - INTERVAL '2 hours'
        AND COALESCE(is_test, FALSE) = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM provider_events pe
           WHERE pe.payload_json ILIKE '%' || messages.provider_id || '%'
        )`,
  );

  // Unprocessed suppression webhooks never age healthy without resolve/waiver.
  const suppressionLag = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM provider_events
      WHERE processed_at IS NULL
        AND waived_at IS NULL
        AND resolved_at IS NULL
        AND event_type IN (
          'email.bounced', 'email.complained', 'email.suppressed',
          'contact.updated', 'email.unsubscribed'
        )`,
  );

  const unresolvedJobs = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM launch_jobs
      WHERE status IN (
        'pending', 'running', 'ready_to_submit', 'submitting',
        'reconciling', 'submission_unknown', 'manual_review'
      )
        AND ($1::text IS NULL OR id <> $1)
        AND ($2::text IS NULL OR campaign_id <> $2)`,
    [ignoreJobId, ignoreCampaignId],
  );

  const ambiguous = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM (
        SELECT id FROM campaigns
         WHERE status = 'submission_unknown'
           AND ($1::text IS NULL OR id <> $1)
        UNION ALL
        SELECT id FROM campaign_recipients
         WHERE status = 'submission_unknown'
           AND ($1::text IS NULL OR campaign_id <> $1)
      ) ambiguous`,
    [ignoreCampaignId],
  );

  const missingBroadcastWebhooks = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM campaigns c
      WHERE c.provider_broadcast_id IS NOT NULL
        AND (c.status IN ('sending', 'reconciling') OR c.provider_status IN ('queued', 'sending'))
        AND c.updated_at < NOW() - INTERVAL '10 minutes'
        AND ($1::text IS NULL OR c.id <> $1)
        AND NOT EXISTS (
          SELECT 1 FROM provider_events pe
           WHERE pe.payload_json ILIKE '%' || c.provider_broadcast_id || '%'
              OR pe.payload_json ILIKE '%' || c.id || '%'
        )`,
    [ignoreCampaignId],
  );

  // Stale unprocessed events: never drop solely by aging past 7 days.
  const staleProviderEvents = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM provider_events
      WHERE processed_at IS NULL
        AND waived_at IS NULL
        AND resolved_at IS NULL
        AND created_at < NOW() - INTERVAL '3 minutes'`,
  );

  const openBlocks = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM delivery_health_blocks
      WHERE resolved_at IS NULL AND waived_at IS NULL`,
  );

  const stuckCaptured = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM messages
      WHERE status = 'captured'
        AND created_at < NOW() - INTERVAL '30 minutes'
        AND COALESCE(is_test, FALSE) = FALSE
        AND (
          campaign_id IN (
            SELECT id FROM campaigns
             WHERE status IN ('sending', 'submission_unknown', 'reconciling')
                OR provider_broadcast_id IS NOT NULL
          )
          OR provider_id IS NOT NULL
        )
        AND ($1::text IS NULL OR campaign_id IS DISTINCT FROM $1)`,
    [ignoreCampaignId],
  );

  const row = counts.rows[0];
  const submitted = Number(row?.submitted ?? 0);
  const delivered = Number(row?.delivered ?? 0);
  const delayed = Number(row?.delayed ?? 0);
  const bounced = Number(row?.bounced ?? 0);
  const failed = Number(row?.failed ?? 0);
  const complained = Number(durableSignals.rows[0]?.complained ?? 0);
  const suppressed = Number(durableSignals.rows[0]?.suppressed ?? 0);
  const unsubscribed = Number(durableSignals.rows[0]?.unsubscribed ?? 0);
  const sampleSize =
    submitted + delivered + delayed + bounced + complained + suppressed + unsubscribed + failed;

  const bounceRate = rate(bounced, sampleSize);
  const complaintRate = rate(complained, sampleSize);
  const unsubscribeRate = rate(unsubscribed, sampleSize);
  const delayRate = rate(delayed, sampleSize);
  const failureRate = rate(failed, sampleSize);

  const received = Number(webhooks.rows[0]?.received ?? 0);
  const processed = Number(webhooks.rows[0]?.processed ?? 0);
  const uncorrelatedCount = Number(uncorrelated.rows[0]?.count ?? 0);
  const suppressionLagCount = Number(suppressionLag.rows[0]?.count ?? 0);
  const unresolvedJobCount = Number(unresolvedJobs.rows[0]?.count ?? 0);
  const ambiguousCount = Number(ambiguous.rows[0]?.count ?? 0);
  const missingBroadcastCount = Number(missingBroadcastWebhooks.rows[0]?.count ?? 0);
  const staleEventCount = Number(staleProviderEvents.rows[0]?.count ?? 0);
  const stuckCapturedCount = Number(stuckCaptured.rows[0]?.count ?? 0);
  const openBlockCount = Number(openBlocks.rows[0]?.count ?? 0);

  const issues: string[] = [];
  const blockingReasons: string[] = [];

  if (!thresholds.configured) {
    issues.push("Delivery health thresholds are not configured.");
  }
  if (thresholds.emergencyStop) {
    issues.push("Emergency stop is enabled.");
    blockingReasons.push("SENDSTACK_EMERGENCY_STOP is enabled.");
  }
  if (uncorrelatedCount > 0) {
    issues.push(`${uncorrelatedCount} submitted message(s) lack matching webhook correlation.`);
    blockingReasons.push("Webhook correlation incomplete.");
  }
  if (suppressionLagCount > 0) {
    issues.push(`${suppressionLagCount} suppression-related webhook event(s) are still unprocessed.`);
    blockingReasons.push("Suppression synchronization incomplete.");
  }
  if (received > 0 && processed < received) {
    issues.push("Some provider webhook events have not finished processing.");
    blockingReasons.push("Unprocessed webhook events remain.");
  }
  if (unresolvedJobCount > 0) {
    const reason = `${unresolvedJobCount} unresolved launch job(s) (pending/running/reconciling/submission_unknown/manual_review).`;
    issues.push(reason);
    blockingReasons.push(reason);
  }
  if (ambiguousCount > 0) {
    const reason = `${ambiguousCount} campaign/recipient row(s) are in submission_unknown.`;
    issues.push(reason);
    blockingReasons.push(reason);
  }
  if (missingBroadcastCount > 0) {
    const reason = `${missingBroadcastCount} broadcast campaign(s) lack recent provider webhook events.`;
    issues.push(reason);
    blockingReasons.push(reason);
  }
  if (staleEventCount > 0) {
    const reason = `${staleEventCount} provider event(s) remain unprocessed after several minutes.`;
    issues.push(reason);
    blockingReasons.push(reason);
  }
  if (stuckCapturedCount > 0) {
    const reason = `${stuckCapturedCount} message(s) stuck in captured without webhook correlation after submission.`;
    issues.push(reason);
    blockingReasons.push(reason);
  }
  if (openBlockCount > 0) {
    const reason = `${openBlockCount} durable delivery health block(s) require explicit resolution or waiver.`;
    issues.push(reason);
    blockingReasons.push(reason);
  }

  if (thresholds.configured && sampleSize >= thresholds.minSample) {
    if (bounceRate > thresholds.maxBounceRate) {
      const reason = `Bounce rate ${(bounceRate * 100).toFixed(2)}% exceeds threshold ${(thresholds.maxBounceRate * 100).toFixed(2)}%.`;
      issues.push(reason);
      blockingReasons.push(reason);
    }
    if (complaintRate > thresholds.maxComplaintRate) {
      const reason = `Complaint rate ${(complaintRate * 100).toFixed(2)}% exceeds threshold ${(thresholds.maxComplaintRate * 100).toFixed(2)}%.`;
      issues.push(reason);
      blockingReasons.push(reason);
    }
    if (unsubscribeRate > thresholds.maxUnsubscribeRate) {
      const reason = `Unsubscribe rate ${(unsubscribeRate * 100).toFixed(2)}% exceeds threshold ${(thresholds.maxUnsubscribeRate * 100).toFixed(2)}%.`;
      issues.push(reason);
      blockingReasons.push(reason);
    }
    if (delayRate > thresholds.maxDelayRate) {
      const reason = `Delay rate ${(delayRate * 100).toFixed(2)}% exceeds threshold ${(thresholds.maxDelayRate * 100).toFixed(2)}%.`;
      issues.push(reason);
      blockingReasons.push(reason);
    }
    if (failureRate > thresholds.maxFailureRate) {
      const reason = `Failure rate ${(failureRate * 100).toFixed(2)}% exceeds threshold ${(thresholds.maxFailureRate * 100).toFixed(2)}%.`;
      issues.push(reason);
      blockingReasons.push(reason);
    }
  }

  if (sampleSize > 0 && (complaintRate >= 1 || bounceRate >= 1)) {
    const reason =
      complaintRate >= 1
        ? "Complaint rate is 100% for the current sample."
        : "Bounce rate is 100% for the current sample.";
    if (!issues.includes(reason)) issues.push(reason);
    if (!blockingReasons.includes(reason)) blockingReasons.push(reason);
  }

  const webhookCorrelationComplete = uncorrelatedCount === 0 && missingBroadcastCount === 0;
  const healthy = issues.length === 0;
  const launchBlocked = blockingReasons.length > 0;

  return {
    submitted,
    delivered,
    delayed,
    bounced,
    complained,
    suppressed,
    unsubscribed,
    failed,
    sample_size: sampleSize,
    bounce_rate: bounceRate,
    complaint_rate: complaintRate,
    unsubscribe_rate: unsubscribeRate,
    delay_rate: delayRate,
    failure_rate: failureRate,
    webhook_events_received: received,
    webhook_events_processed: processed,
    webhook_correlation_complete: webhookCorrelationComplete,
    suppression_sync_healthy: suppressionLagCount === 0,
    thresholds_configured: thresholds.configured,
    emergency_stop: thresholds.emergencyStop,
    healthy,
    launch_blocked: launchBlocked,
    blocking_reasons: blockingReasons,
    issues,
  };
}

export function assertLaunchAllowedByHealth(
  health: DeliveryHealthSnapshot,
  options?: { requireThresholds?: boolean },
): void {
  if (options?.requireThresholds && !health.thresholds_configured) {
    throw new Error(
      "Configure SENDSTACK_HEALTH_MIN_SAMPLE and SENDSTACK_HEALTH_MAX_*_RATE before live sending.",
    );
  }
  if (health.launch_blocked) {
    throw new Error(health.blocking_reasons[0] || "Delivery health gate blocked launch.");
  }
}

/**
 * Recheck used by the launch worker / live test send immediately before provider submission.
 * Ignores only the current job/campaign expected in-flight state; unrelated work stays blocking.
 * Thresholds are required again at submit time for live paths.
 */
export async function assertDeliveryHealthAllowsSubmit(
  context?: HealthSubmitContext & { requireThresholds?: boolean },
): Promise<DeliveryHealthSnapshot> {
  const requireThresholds = context?.requireThresholds ?? true;
  const health = await getDeliveryHealthSnapshot({
    jobId: context?.jobId,
    campaignId: context?.campaignId,
  });
  if (requireThresholds && !health.thresholds_configured) {
    throw new Error(
      "Configure SENDSTACK_HEALTH_MIN_SAMPLE and SENDSTACK_HEALTH_MAX_*_RATE before provider submission.",
    );
  }
  if (health.blocking_reasons.length > 0) {
    throw new Error(health.blocking_reasons[0] || "Delivery health gate blocked provider submission.");
  }
  return health;
}
