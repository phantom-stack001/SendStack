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

  // Rate envs are display-only under Spacemail SMTP (no delivery webhooks).
  // Launch is gated by emergency stop and queue integrity, not ESP reputation rates.
  const configured = true;

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

export type DeliveryHealthBlockKind =
  | "unprocessed_webhook"
  | "submission_unknown"
  | "unresolved_launch_job"
  | "manual_review"
  | "stuck_captured"
  | "other";

/** Record an open health block that cannot age healthy without explicit resolve/waiver. */
export async function recordDeliveryHealthBlock(
  input: {
    kind: DeliveryHealthBlockKind;
    detail: string;
    relatedEntityType?: string | null;
    relatedEntityId?: string | null;
  },
  options?: { preempt?: boolean },
): Promise<string> {
  const id = makeId("dhb");
  const { getPool } = await import("./db");
  const { lockSubmitBarrier } = await import("./submit-barrier");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Outcome records written while a worker already holds the submit barrier must not
    // take that lock again (it would deadlock). Preempting blocks do take it, so they
    // commit before the final check or wait until after the provider call.
    if (options?.preempt !== false) await lockSubmitBarrier(client);
    await client.query(
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return id;
}

/**
 * Idempotent block for a related entity: reuses an open block of the same kind
 * instead of flooding the table on every worker tick.
 */
export async function ensureDeliveryHealthBlock(input: {
  kind: DeliveryHealthBlockKind;
  detail: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
}): Promise<string> {
  if (input.relatedEntityId) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM delivery_health_blocks
        WHERE kind = $1
          AND related_entity_id = $2
          AND resolved_at IS NULL
          AND waived_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.kind, input.relatedEntityId],
    );
    if (existing.rows[0]) return existing.rows[0].id;
  }
  return recordDeliveryHealthBlock(input, { preempt: false });
}

export async function resolveDeliveryHealthBlock(input: {
  blockId: string;
  actorUserId: string;
  note: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const note = input.note.trim();
  if (note.length < 8) {
    return { ok: false, error: "Resolution note must be at least 8 characters." };
  }
  const updated = await query<{ id: string }>(
    `UPDATE delivery_health_blocks
        SET resolved_at = NOW(),
            waiver_note = COALESCE(waiver_note, $2)
      WHERE id = $1
        AND resolved_at IS NULL
        AND waived_at IS NULL
      RETURNING id`,
    [input.blockId, note.slice(0, 500)],
  );
  if (!updated.rows[0]) {
    return { ok: false, error: "Health block not found or already closed." };
  }
  await query(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
     VALUES ($1, 'delivery_health_block_resolved', 'delivery_health_block', $2, $3, NOW())`,
    [input.actorUserId, input.blockId, JSON.stringify({ note: note.slice(0, 500) })],
  );
  return { ok: true };
}

export async function waiveDeliveryHealthBlock(input: {
  blockId: string;
  actorUserId: string;
  note: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const note = input.note.trim();
  if (note.length < 20) {
    return { ok: false, error: "Waiver note must be at least 20 characters of audit evidence." };
  }
  const updated = await query<{ id: string }>(
    `UPDATE delivery_health_blocks
        SET waived_at = NOW(),
            waived_by = $2,
            waiver_note = $3
      WHERE id = $1
        AND resolved_at IS NULL
        AND waived_at IS NULL
      RETURNING id`,
    [input.blockId, input.actorUserId, note.slice(0, 500)],
  );
  if (!updated.rows[0]) {
    return { ok: false, error: "Health block not found or already closed." };
  }
  await query(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
     VALUES ($1, 'delivery_health_block_waived', 'delivery_health_block', $2, $3, NOW())`,
    [input.actorUserId, input.blockId, JSON.stringify({ note: note.slice(0, 500) })],
  );
  return { ok: true };
}

export async function listOpenDeliveryHealthBlocks() {
  const result = await query<{
    id: string;
    kind: string;
    detail: string;
    related_entity_type: string | null;
    related_entity_id: string | null;
    created_at: string;
  }>(
    `SELECT id, kind, detail, related_entity_type, related_entity_id, created_at
       FROM delivery_health_blocks
      WHERE resolved_at IS NULL AND waived_at IS NULL
      ORDER BY created_at ASC
      LIMIT 200`,
  );
  return result.rows;
}

/** Health report used when the schema is not ready to query application tables. */
export function blockedHealthSnapshot(reason: string): DeliveryHealthSnapshot {
  return {
    submitted: 0,
    delivered: 0,
    delayed: 0,
    bounced: 0,
    complained: 0,
    suppressed: 0,
    unsubscribed: 0,
    failed: 0,
    sample_size: 0,
    bounce_rate: 0,
    complaint_rate: 0,
    unsubscribe_rate: 0,
    delay_rate: 0,
    failure_rate: 0,
    webhook_events_received: 0,
    webhook_events_processed: 0,
    webhook_correlation_complete: true,
    suppression_sync_healthy: true,
    thresholds_configured: false,
    emergency_stop: false,
    healthy: false,
    launch_blocked: true,
    blocking_reasons: [reason],
    issues: [reason],
  };
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

  const openBlocks = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM delivery_health_blocks
      WHERE resolved_at IS NULL AND waived_at IS NULL`,
  );

  // Cancel/outcome stalls must not sit indefinitely without a health blocker.
  const cancelStalls = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM (
        SELECT id FROM campaigns
         WHERE status IN ('cancel_requested', 'partially_sent')
           AND updated_at < NOW() - INTERVAL '15 minutes'
           AND ($1::text IS NULL OR id <> $1)
        UNION ALL
        SELECT DISTINCT campaign_id AS id FROM campaign_recipients
         WHERE status IN ('outcome_pending', 'cancel_requested')
           AND queued_at < NOW() - INTERVAL '15 minutes'
           AND ($1::text IS NULL OR campaign_id <> $1)
        UNION ALL
        SELECT id FROM launch_jobs
         WHERE cancel_requested_at IS NOT NULL
           AND status NOT IN ('completed', 'failed', 'cancelled', 'manual_review')
           AND cancel_requested_at < NOW() - INTERVAL '15 minutes'
           AND ($2::text IS NULL OR id <> $2)
           AND ($1::text IS NULL OR campaign_id <> $1)
      ) stalls`,
    [ignoreCampaignId, ignoreJobId],
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

  const unresolvedJobCount = Number(unresolvedJobs.rows[0]?.count ?? 0);
  const ambiguousCount = Number(ambiguous.rows[0]?.count ?? 0);
  const stuckCapturedCount = Number(stuckCaptured.rows[0]?.count ?? 0);
  const openBlockCount = Number(openBlocks.rows[0]?.count ?? 0);
  const cancelStallCount = Number(cancelStalls.rows[0]?.count ?? 0);

  const issues: string[] = [];
  const blockingReasons: string[] = [];

  if (thresholds.emergencyStop) {
    issues.push("Emergency stop is enabled.");
    blockingReasons.push("SENDSTACK_EMERGENCY_STOP is enabled.");
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
  if (stuckCapturedCount > 0) {
    const reason = `${stuckCapturedCount} message(s) stuck in captured after an SMTP submission attempt.`;
    issues.push(reason);
    blockingReasons.push(reason);
  }
  if (openBlockCount > 0) {
    const reason = `${openBlockCount} durable delivery health block(s) require explicit resolution or waiver.`;
    issues.push(reason);
    blockingReasons.push(reason);
  }
  if (cancelStallCount > 0) {
    const reason = `${cancelStallCount} cancel/outcome_pending stall(s) require reconciliation or manual review.`;
    issues.push(reason);
    blockingReasons.push(reason);
  }

  // Optional rate envs are informational only (Spacemail has no delivery webhooks).
  if (thresholds.minSample > 0 && sampleSize >= thresholds.minSample) {
    if (bounceRate > thresholds.maxBounceRate) {
      issues.push(
        `Bounce rate ${(bounceRate * 100).toFixed(2)}% exceeds display threshold ${(thresholds.maxBounceRate * 100).toFixed(2)}%.`,
      );
    }
    if (complaintRate > thresholds.maxComplaintRate) {
      issues.push(
        `Complaint rate ${(complaintRate * 100).toFixed(2)}% exceeds display threshold ${(thresholds.maxComplaintRate * 100).toFixed(2)}%.`,
      );
    }
    if (unsubscribeRate > thresholds.maxUnsubscribeRate) {
      issues.push(
        `Unsubscribe rate ${(unsubscribeRate * 100).toFixed(2)}% exceeds display threshold ${(thresholds.maxUnsubscribeRate * 100).toFixed(2)}%.`,
      );
    }
    if (delayRate > thresholds.maxDelayRate) {
      issues.push(
        `Delay rate ${(delayRate * 100).toFixed(2)}% exceeds display threshold ${(thresholds.maxDelayRate * 100).toFixed(2)}%.`,
      );
    }
    if (failureRate > thresholds.maxFailureRate) {
      issues.push(
        `Failure rate ${(failureRate * 100).toFixed(2)}% exceeds display threshold ${(thresholds.maxFailureRate * 100).toFixed(2)}%.`,
      );
    }
  }

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
    // Spacemail SMTP has no delivery webhooks; fields retained for API compatibility.
    webhook_events_received: 0,
    webhook_events_processed: 0,
    webhook_correlation_complete: true,
    suppression_sync_healthy: true,
    thresholds_configured: thresholds.configured,
    emergency_stop: thresholds.emergencyStop,
    healthy,
    launch_blocked: launchBlocked,
    blocking_reasons: blockingReasons,
    issues,
  };
}

export function assertLaunchAllowedByHealth(health: DeliveryHealthSnapshot): void {
  if (health.launch_blocked) {
    throw new Error(health.blocking_reasons[0] || "Delivery health gate blocked launch.");
  }
}

/**
 * Recheck used by the launch worker / live test send immediately before provider submission.
 * Ignores only the current job/campaign expected in-flight state; unrelated work stays blocking.
 */
export async function assertDeliveryHealthAllowsSubmit(
  context?: HealthSubmitContext,
): Promise<DeliveryHealthSnapshot> {
  const health = await getDeliveryHealthSnapshot({
    jobId: context?.jobId,
    campaignId: context?.campaignId,
  });
  if (health.blocking_reasons.length > 0) {
    throw new Error(health.blocking_reasons[0] || "Delivery health gate blocked provider submission.");
  }
  return health;
}
