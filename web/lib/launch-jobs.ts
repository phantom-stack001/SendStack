import { applyComplianceFooter } from "./compliance-footer";
import {
  consumeDailyReservationsForCampaign,
  releaseDailyReservationsForCampaign,
  reserveDailyVolumeBatch,
} from "./daily-volume";
import { getPool, query } from "./db";
import { assertDeliveryHealthAllowsSubmit } from "./delivery-health";
import { makeId } from "./ids";
import {
  addContactToSegment,
  buildIdempotencyKey,
  cancelResendBroadcast,
  createResendBroadcastDraft,
  createResendSegment,
  getResendBroadcast,
  getResendContactImport,
  importResendContactsCsv,
  liveSendAllowed,
  sendResendBroadcast,
  toResendBroadcastHtml,
  toResendBroadcastText,
  upsertResendContact,
} from "./providers/resend";
import { loadSendingIdentity } from "./sending-identity";
import { isSpecialUseRecipientDomain, validateLiveRecipient } from "./recipients";

export const DEFAULT_LAUNCH_CHUNK_SIZE = 100;
export const LAUNCH_LEASE_SECONDS = 60;
const SEQUENTIAL_FALLBACK_MAX_CHUNK = 20;
const PROVIDER_OP_MIN_BUDGET_MS = 2_000;

export type LaunchJobRow = {
  id: string;
  campaign_id: string;
  status: string;
  cursor_offset: number;
  total_recipients: number;
  chunk_size: number;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_generation: number;
  live_mode: boolean;
  snapshot_json: unknown | null;
  max_attempts: number;
  next_retry_at: string | null;
  cancel_requested_at: string | null;
  terminal_reason: string | null;
  provider_segment_id: string | null;
  provider_broadcast_id: string | null;
  provider_import_id: string | null;
  reservation_batch_id: string | null;
  last_error: string | null;
};

type ResendProvider = typeof import("./providers/resend");
type ProcessOptions = {
  provider?: Partial<ResendProvider>;
  live?: boolean;
};

type CampaignLaunchRow = {
  id: string;
  subject: string;
  from_name: string;
  from_email: string;
  reply_to_email: string | null;
  html_body: string;
  text_body: string;
  list_id: string;
  status: string;
  provider_broadcast_id: string | null;
  provider_segment_id: string | null;
  launch_job_id: string | null;
  cancel_requested?: boolean;
};

type LaunchSnapshot = {
  subject: string;
  from_name: string;
  from_email: string;
  reply_to_email: string | null;
  html_body: string;
  text_body: string;
  list_id: string;
  live_mode: boolean;
};

function emergencyStopEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.SENDSTACK_EMERGENCY_STOP ?? "").trim().toLowerCase(),
  );
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505",
  );
}

function retryBackoffSeconds(attemptCount: number): number {
  return Math.min(3_600, Math.max(5, 2 ** Math.min(attemptCount, 10)));
}

async function loadActiveJobForCampaign(campaignId: string): Promise<LaunchJobRow | null> {
  const result = await query<LaunchJobRow>(
    `SELECT * FROM launch_jobs
      WHERE campaign_id = $1
        AND status IN ('pending', 'running', 'ready_to_submit', 'submitting', 'reconciling', 'submission_unknown')
      ORDER BY created_at ASC
      LIMIT 1`,
    [campaignId],
  );
  return result.rows[0] ?? null;
}

async function loadJobById(jobId: string): Promise<LaunchJobRow | null> {
  const result = await query<LaunchJobRow>(`SELECT * FROM launch_jobs WHERE id = $1`, [jobId]);
  return result.rows[0] ?? null;
}

/**
 * Atomic create of a durable launch job. Idempotent when an active job already exists.
 * Does not call Resend — HTTP launch must return promptly.
 */
export async function createLaunchJob(input: {
  campaignId: string;
  totalRecipients: number;
  chunkSize?: number;
  reservationBatchId?: string;
  liveMode?: boolean;
  snapshotJson?: unknown;
}): Promise<LaunchJobRow> {
  const existing = await loadActiveJobForCampaign(input.campaignId);
  if (existing) return existing;

  const id = makeId("lj");
  const chunkSize = input.chunkSize ?? DEFAULT_LAUNCH_CHUNK_SIZE;
  const liveMode = input.liveMode ?? liveSendAllowed();
  const snapshotJson = input.snapshotJson ?? null;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<{ id: string }>(
      `UPDATE campaigns
          SET status = 'sending',
              frozen_at = COALESCE(frozen_at, NOW()),
              launch_snapshot = COALESCE(launch_snapshot, $1::jsonb),
              launch_job_id = $2,
              provider_status = 'launch_queued',
              launched_at = COALESCE(launched_at, NOW()),
              cancellable = TRUE,
              updated_at = NOW()
        WHERE id = $3
          AND status IN ('draft', 'paused')
          AND launch_job_id IS NULL
        RETURNING id`,
      [snapshotJson ? JSON.stringify(snapshotJson) : null, id, input.campaignId],
    );

    if (!claimed.rows[0]) {
      await client.query("ROLLBACK");
      const active = await loadActiveJobForCampaign(input.campaignId);
      if (active) return active;
      const linked = await query<{ launch_job_id: string | null }>(
        `SELECT launch_job_id FROM campaigns WHERE id = $1`,
        [input.campaignId],
      );
      if (linked.rows[0]?.launch_job_id) {
        const job = await loadJobById(linked.rows[0].launch_job_id);
        if (job) return job;
      }
      throw new Error("Campaign is not launchable (wrong status or already has a launch job).");
    }

    try {
      await client.query(
        `INSERT INTO launch_jobs
           (id, campaign_id, status, cursor_offset, total_recipients, chunk_size, attempt_count,
            live_mode, snapshot_json, reservation_batch_id, created_at, updated_at)
         VALUES ($1, $2, 'pending', 0, $3, $4, 0, $5, $6::jsonb, $7, NOW(), NOW())`,
        [
          id,
          input.campaignId,
          input.totalRecipients,
          chunkSize,
          liveMode,
          snapshotJson ? JSON.stringify(snapshotJson) : null,
          input.reservationBatchId ?? null,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        await client.query("ROLLBACK");
        const active = await loadActiveJobForCampaign(input.campaignId);
        if (active) return active;
      }
      throw error;
    }

    await client.query("COMMIT");
    const result = await query<LaunchJobRow>(`SELECT * FROM launch_jobs WHERE id = $1`, [id]);
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isUniqueViolation(error)) {
      const active = await loadActiveJobForCampaign(input.campaignId);
      if (active) return active;
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Atomic CAS launch: freeze snapshot, create one job, set-based recipient/message inserts,
 * and set-based volume reservations. Never calls Resend.
 */
export async function claimAndPrepareCampaignLaunch(input: {
  campaignId: string;
  chunkSize?: number;
  liveMode?: boolean;
  fromEmail?: string;
  replyToEmail?: string | null;
  htmlBody?: string;
  textBody?: string;
  validateLiveRecipients?: boolean;
}): Promise<{ job: LaunchJobRow; totalRecipients: number; idempotent: boolean }> {
  const existing = await loadActiveJobForCampaign(input.campaignId);
  if (existing) {
    return { job: existing, totalRecipients: existing.total_recipients, idempotent: true };
  }

  const campaignResult = await query<CampaignLaunchRow>(
    `SELECT id, subject, from_name, from_email, reply_to_email, html_body, text_body, list_id,
            status, provider_broadcast_id, provider_segment_id, launch_job_id
       FROM campaigns WHERE id = $1`,
    [input.campaignId],
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw new Error("Campaign not found.");
  if (!["draft", "paused"].includes(campaign.status) || campaign.launch_job_id) {
    const active = await loadActiveJobForCampaign(input.campaignId);
    if (active) return { job: active, totalRecipients: active.total_recipients, idempotent: true };
    throw new Error("Campaign is not launchable (wrong status or already has a launch job).");
  }

  const identity = loadSendingIdentity();
  const liveMode = input.liveMode ?? liveSendAllowed();
  const fromEmail = input.fromEmail ?? campaign.from_email;
  const replyTo = input.replyToEmail ?? campaign.reply_to_email ?? identity.replyToEmail ?? null;
  const footered = applyComplianceFooter(
    input.htmlBody ?? campaign.html_body,
    input.textBody ?? campaign.text_body,
    identity,
    { broadcast: true },
  );
  const snapshot: LaunchSnapshot = {
    subject: campaign.subject,
    from_name: campaign.from_name,
    from_email: fromEmail,
    reply_to_email: replyTo,
    html_body: footered.html,
    text_body: footered.text,
    list_id: campaign.list_id,
    live_mode: liveMode,
  };

  const jobId = makeId("lj");
  const chunkSize = input.chunkSize ?? DEFAULT_LAUNCH_CHUNK_SIZE;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const claimed = await client.query<{ id: string }>(
      `UPDATE campaigns
          SET status = 'sending',
              frozen_at = NOW(),
              launch_snapshot = $1::jsonb,
              launch_job_id = $2,
              from_email = $3,
              reply_to_email = $4,
              provider_status = 'launch_queued',
              launched_at = COALESCE(launched_at, NOW()),
              cancellable = TRUE,
              updated_at = NOW()
        WHERE id = $5
          AND status IN ('draft', 'paused')
          AND launch_job_id IS NULL
        RETURNING id`,
      [JSON.stringify(snapshot), jobId, fromEmail, replyTo, input.campaignId],
    );
    if (!claimed.rows[0]) {
      await client.query("ROLLBACK");
      const active = await loadActiveJobForCampaign(input.campaignId);
      if (active) return { job: active, totalRecipients: active.total_recipients, idempotent: true };
      throw new Error("Campaign is not launchable (wrong status or already has a launch job).");
    }

    const insertedRecipients = await client.query<{ id: string; contact_id: string; message_id: string }>(
      `WITH active_contacts AS (
         SELECT c.id AS contact_id, c.email, c.first_name, c.last_name
           FROM contacts c
           JOIN list_contacts lc ON lc.contact_id = c.id
          WHERE lc.list_id = $1
            AND c.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)
       ),
       prepared AS (
         SELECT contact_id,
                email,
                first_name,
                last_name,
                'rec_' || replace(gen_random_uuid()::text, '-', '') AS recipient_id,
                'msg_' || replace(gen_random_uuid()::text, '-', '') AS message_id
           FROM active_contacts
       )
       INSERT INTO campaign_recipients
         (id, campaign_id, contact_id, email, first_name, last_name, status, message_id, provider_email_id, queued_at, sent_at)
       SELECT recipient_id, $2, contact_id, email, first_name, last_name, 'queued', message_id, NULL, NOW(), NULL
         FROM prepared
       ON CONFLICT (campaign_id, contact_id) DO UPDATE
         SET email = EXCLUDED.email,
             first_name = COALESCE(campaign_recipients.first_name, EXCLUDED.first_name),
             last_name = COALESCE(campaign_recipients.last_name, EXCLUDED.last_name),
             message_id = COALESCE(campaign_recipients.message_id, EXCLUDED.message_id)
       RETURNING id, contact_id, message_id`,
      [campaign.list_id, input.campaignId],
    );

    if (input.validateLiveRecipients) {
      const emails = await client.query<{ email: string }>(
        `SELECT email FROM campaign_recipients WHERE campaign_id = $1`,
        [input.campaignId],
      );
      for (const row of emails.rows) {
        if (isSpecialUseRecipientDomain(row.email)) {
          await client.query("ROLLBACK");
          throw new Error("Audience contains special-use domains that cannot receive live email.");
        }
        const live = validateLiveRecipient(row.email);
        if (!live.ok) {
          await client.query("ROLLBACK");
          throw new Error(`Recipient ${row.email}: ${live.error}`);
        }
      }
    }

    await client.query(
      `INSERT INTO messages
         (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email, reply_to_email,
          html_body, text_body, status, unsubscribe_token, created_at, idempotency_key, diagnostic_json,
          is_test, volume_reservation_id)
       SELECT cr.message_id,
              cr.campaign_id,
              cr.id,
              cr.contact_id,
              cr.email,
              $2,
              $3,
              $4,
              $5,
              $6,
              'captured',
              replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
              NOW(),
              $7 || ':' || cr.campaign_id || ':' || cr.contact_id,
              $8::jsonb,
              FALSE,
              NULL
         FROM campaign_recipients cr
        WHERE cr.campaign_id = $1
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.recipient_id = cr.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages m2
             WHERE m2.idempotency_key = ($7 || ':' || cr.campaign_id || ':' || cr.contact_id)
          )
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        input.campaignId,
        snapshot.subject,
        fromEmail,
        replyTo,
        footered.html,
        footered.text,
        "broadcast",
        JSON.stringify({ intent: "broadcast", campaign_id: input.campaignId }),
      ],
    );

    // Align recipient.message_id with the durable message row when conflict reused an older id.
    await client.query(
      `UPDATE campaign_recipients cr
          SET message_id = m.id
         FROM messages m
        WHERE m.recipient_id = cr.id
          AND cr.campaign_id = $1
          AND cr.message_id IS DISTINCT FROM m.id`,
      [input.campaignId],
    );

    const messageRows = await client.query<{ id: string; contact_id: string }>(
      `SELECT id, contact_id FROM messages
        WHERE campaign_id = $1 AND COALESCE(is_test, FALSE) = FALSE`,
      [input.campaignId],
    );
    const totalRecipients = messageRows.rows.length || insertedRecipients.rows.length;
    const batchId = makeId("dvb");
    const messageIdByKey: Record<string, string> = {};
    const reservationKeys = messageRows.rows.map((row) => {
      const key = `broadcast:${input.campaignId}:${row.contact_id}`;
      messageIdByKey[key] = row.id;
      return key;
    });

    const volume = await reserveDailyVolumeBatch({
      client,
      campaignId: input.campaignId,
      reservationKeys,
      attemptKey: batchId,
      messageIdByKey,
    });
    if (!volume.ok) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error(volume.error), { used: volume.used, limit: volume.limit, status: 429 });
    }

    await client.query(
      `UPDATE messages m
          SET volume_reservation_id = r.id
         FROM daily_volume_reservations r
        WHERE r.campaign_id = $1
          AND r.message_id = m.id
          AND m.campaign_id = $1
          AND m.volume_reservation_id IS NULL`,
      [input.campaignId],
    );

    try {
      await client.query(
        `INSERT INTO launch_jobs
           (id, campaign_id, status, cursor_offset, total_recipients, chunk_size, attempt_count,
            live_mode, snapshot_json, reservation_batch_id, created_at, updated_at)
         VALUES ($1, $2, 'pending', 0, $3, $4, 0, $5, $6::jsonb, $7, NOW(), NOW())`,
        [
          jobId,
          input.campaignId,
          totalRecipients,
          chunkSize,
          liveMode,
          JSON.stringify(snapshot),
          volume.batchId ?? batchId,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        await client.query("ROLLBACK");
        const active = await loadActiveJobForCampaign(input.campaignId);
        if (active) return { job: active, totalRecipients: active.total_recipients, idempotent: true };
      }
      throw error;
    }

    await client.query("COMMIT");
    const job = await loadJobById(jobId);
    if (!job) throw new Error("Launch job missing after commit.");
    return { job, totalRecipients, idempotent: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isUniqueViolation(error)) {
      const active = await loadActiveJobForCampaign(input.campaignId);
      if (active) return { job: active, totalRecipients: active.total_recipients, idempotent: true };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function claimLaunchJob(workerId: string): Promise<LaunchJobRow | null> {
  const claimed = await query<LaunchJobRow>(
    `UPDATE launch_jobs
        SET status = CASE
              WHEN status IN ('pending', 'running') THEN 'running'
              ELSE status
            END,
            lease_owner = $1,
            lease_expires_at = NOW() + ($2 || ' seconds')::interval,
            lease_generation = lease_generation + 1,
            attempt_count = attempt_count + 1,
            next_retry_at = NULL,
            updated_at = NOW()
      WHERE id = (
        SELECT id FROM launch_jobs
         WHERE status IN ('pending', 'running', 'ready_to_submit', 'submitting', 'reconciling', 'submission_unknown')
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           AND cancel_requested_at IS NULL
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [workerId, String(LAUNCH_LEASE_SECONDS)],
  );
  const job = claimed.rows[0] ?? null;
  if (!job) return null;
  if (job.attempt_count > job.max_attempts) {
    await query(
      `UPDATE launch_jobs
          SET status = 'manual_review',
              terminal_reason = 'max_attempts_exceeded',
              lease_owner = NULL,
              lease_expires_at = NOW(),
              last_error = COALESCE(last_error, 'Exceeded max attempts'),
              updated_at = NOW()
        WHERE id = $1
          AND lease_owner = $2
          AND lease_generation = $3`,
      [job.id, workerId, job.lease_generation],
    );
    return null;
  }
  return job;
}

/** Renew lease fenced by lease_owner + lease_generation. Stale workers no-op. */
export async function renewLaunchLease(
  job: Pick<LaunchJobRow, "id" | "lease_owner" | "lease_generation">,
  seconds = LAUNCH_LEASE_SECONDS,
): Promise<boolean> {
  if (!job.lease_owner) return false;
  const result = await query<{ id: string }>(
    `UPDATE launch_jobs
        SET lease_expires_at = NOW() + ($1 || ' seconds')::interval,
            updated_at = NOW()
      WHERE id = $2
        AND lease_owner = $3
        AND lease_generation = $4
      RETURNING id`,
    [String(seconds), job.id, job.lease_owner, job.lease_generation],
  );
  return Boolean(result.rows[0]);
}

async function fenceUpdate(
  job: Pick<LaunchJobRow, "id" | "lease_owner" | "lease_generation">,
  setSql: string,
  params: unknown[],
): Promise<boolean> {
  if (!job.lease_owner) return false;
  const ownerIdx = params.length + 1;
  const genIdx = params.length + 2;
  const idIdx = params.length + 3;
  const result = await query<{ id: string }>(
    `UPDATE launch_jobs
        SET ${setSql}, updated_at = NOW()
      WHERE id = $${idIdx}
        AND lease_owner = $${ownerIdx}
        AND lease_generation = $${genIdx}
      RETURNING id`,
    [...params, job.lease_owner, job.lease_generation, job.id],
  );
  return Boolean(result.rows[0]);
}

async function expireLease(job: LaunchJobRow): Promise<void> {
  await fenceUpdate(job, `lease_expires_at = NOW(), lease_owner = NULL`, []);
}

async function scheduleRetry(job: LaunchJobRow, errorMessage: string): Promise<void> {
  if (job.attempt_count >= job.max_attempts) {
    await fenceUpdate(
      job,
      `status = 'manual_review',
       terminal_reason = 'max_attempts_exceeded',
       last_error = $1,
       lease_expires_at = NOW(),
       lease_owner = NULL`,
      [errorMessage.slice(0, 500)],
    );
    return;
  }
  const delay = retryBackoffSeconds(job.attempt_count);
  await fenceUpdate(
    job,
    `status = 'pending',
     last_error = $1,
     next_retry_at = NOW() + ($2 || ' seconds')::interval,
     lease_expires_at = NOW(),
     lease_owner = NULL`,
    [errorMessage.slice(0, 500), String(delay)],
  );
}

async function failJob(
  job: LaunchJobRow,
  reason: string,
  options?: { manualReview?: boolean; releaseVolume?: boolean },
): Promise<{ done: boolean; advanced: number; status: string }> {
  const status = options?.manualReview ? "manual_review" : "failed";
  await fenceUpdate(
    job,
    `status = $1,
     terminal_reason = $2,
     last_error = $3,
     lease_expires_at = NOW(),
     lease_owner = NULL`,
    [status, reason.slice(0, 200), reason.slice(0, 500)],
  );
  await query(
    `UPDATE campaigns
        SET status = CASE WHEN status = 'submission_unknown' THEN status ELSE 'failed' END,
            provider_status = $1,
            cancellable = FALSE,
            updated_at = NOW()
      WHERE id = $2`,
    [status, job.campaign_id],
  );
  if (options?.releaseVolume && !job.provider_broadcast_id) {
    await releaseDailyReservationsForCampaign(job.campaign_id, true);
  }
  return { done: true, advanced: 0, status };
}

async function loadCampaign(campaignId: string): Promise<CampaignLaunchRow | null> {
  const result = await query<CampaignLaunchRow>(
    `SELECT id, subject, from_name, from_email, reply_to_email, html_body, text_body, list_id,
            status, provider_broadcast_id, provider_segment_id, launch_job_id
       FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  return result.rows[0] ?? null;
}

/**
 * Fail-closed late-suppression gate: mark newly-suppressed prepared recipients, then
 * either cancel (zero sendable left) or signal callers to fail the job.
 */
export async function recheckPreparedAudience(
  campaignId: string,
): Promise<{ ok: true } | { ok: false; suppressedEmails: string[] }> {
  const stale = await query<{ id: string; email: string }>(
    `SELECT cr.id, cr.email
       FROM campaign_recipients cr
       LEFT JOIN contacts c ON c.id = cr.contact_id
      WHERE cr.campaign_id = $1
        AND cr.status IN ('queued', 'processing')
        AND (
          EXISTS (SELECT 1 FROM suppressions s WHERE s.email = cr.email)
          OR (c.id IS NOT NULL AND c.status <> 'active')
        )`,
    [campaignId],
  );
  if (!stale.rows.length) return { ok: true };

  const ids = stale.rows.map((row) => row.id);
  await query(
    `UPDATE campaign_recipients
        SET status = 'suppressed'
      WHERE id = ANY($1::text[])
        AND status IN ('queued', 'processing')`,
    [ids],
  );
  return { ok: false, suppressedEmails: stale.rows.map((row) => row.email) };
}

async function enforcePreparedAudience(
  job: LaunchJobRow,
): Promise<{ ok: true } | { ok: false; result: { done: boolean; advanced: number; status: string } }> {
  const check = await recheckPreparedAudience(job.campaign_id);
  if (check.ok) return { ok: true };

  const remaining = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM campaign_recipients
      WHERE campaign_id = $1
        AND status IN ('queued', 'processing')`,
    [job.campaign_id],
  );
  const sendable = Number(remaining.rows[0]?.count ?? 0);
  if (sendable === 0) {
    await fenceUpdate(
      job,
      `status = 'cancelled',
       terminal_reason = 'no_sendable_recipients',
       lease_expires_at = NOW(),
       lease_owner = NULL`,
      [],
    );
    await query(
      `UPDATE campaigns
          SET status = 'cancelled',
              completed_at = COALESCE(completed_at, NOW()),
              cancellable = FALSE,
              provider_status = 'cancelled',
              updated_at = NOW()
        WHERE id = $1
          AND status IN ('sending', 'cancel_requested', 'submission_unknown')`,
      [job.campaign_id],
    );
    if (!job.provider_broadcast_id) {
      await releaseDailyReservationsForCampaign(job.campaign_id, true);
    }
    return { ok: false, result: { done: true, advanced: 0, status: "cancelled" } };
  }

  const preview = check.suppressedEmails.slice(0, 5).join(", ");
  const suffix = check.suppressedEmails.length > 5 ? ", ..." : "";
  return {
    ok: false,
    result: await failJob(
      job,
      `Late suppression after prepare: ${check.suppressedEmails.length} recipient(s) suppressed (${preview}${suffix}). Failing closed to avoid sending a stale segment.`,
      { releaseVolume: !job.provider_broadcast_id },
    ),
  };
}

async function loadFreshProviderBroadcastId(
  jobId: string | null | undefined,
  campaignId: string,
): Promise<string | null> {
  if (jobId) {
    const jobRow = await query<{ provider_broadcast_id: string | null }>(
      `SELECT provider_broadcast_id FROM launch_jobs WHERE id = $1`,
      [jobId],
    );
    if (jobRow.rows[0]?.provider_broadcast_id) return jobRow.rows[0].provider_broadcast_id;
  }
  const campaignRow = await query<{ provider_broadcast_id: string | null }>(
    `SELECT provider_broadcast_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  return campaignRow.rows[0]?.provider_broadcast_id ?? null;
}

async function preflightIrreversibleOp(
  job: LaunchJobRow,
): Promise<{ ok: true } | { ok: false; result: { done: boolean; advanced: number; status: string } }> {
  if (emergencyStopEnabled()) {
    return {
      ok: false,
      result: await failJob(job, "SENDSTACK_EMERGENCY_STOP is enabled.", { manualReview: true }),
    };
  }
  if (job.cancel_requested_at) {
    await fenceUpdate(
      job,
      `status = 'cancelled',
       terminal_reason = 'cancel_requested',
       lease_expires_at = NOW(),
       lease_owner = NULL`,
      [],
    );
    return { ok: false, result: { done: true, advanced: 0, status: "cancelled" } };
  }
  const campaign = await query<{ status: string }>(
    `SELECT status FROM campaigns WHERE id = $1`,
    [job.campaign_id],
  );
  const campaignStatus = campaign.rows[0]?.status;
  if (campaignStatus === "cancel_requested" || campaignStatus === "cancelled" || campaignStatus === "paused") {
    await fenceUpdate(
      job,
      `status = 'cancelled',
       cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
       terminal_reason = 'campaign_cancelled',
       lease_expires_at = NOW(),
       lease_owner = NULL`,
      [],
    );
    return { ok: false, result: { done: true, advanced: 0, status: "cancelled" } };
  }
  if (job.live_mode && !liveSendAllowed()) {
    return {
      ok: false,
      result: await failJob(
        job,
        "Live mode job cannot continue: live credentials/send disabled mid-job.",
        { manualReview: true },
      ),
    };
  }
  if (job.live_mode) {
    try {
      await assertDeliveryHealthAllowsSubmit({
        jobId: job.id,
        campaignId: job.campaign_id,
        requireThresholds: true,
      });
    } catch (error) {
      return {
        ok: false,
        result: await failJob(
          job,
          error instanceof Error ? error.message : "Delivery health blocked provider submission.",
          { manualReview: true },
        ),
      };
    }
  }
  const audience = await enforcePreparedAudience(job);
  if (!audience.ok) return audience;
  return { ok: true };
}

async function pollContactImportOnce(
  job: LaunchJobRow,
  importId: string,
  importRowId: string,
  options?: ProcessOptions,
): Promise<
  | { ok: true; counts: { failed?: number } }
  | { ok: false; error: string }
  | { pending: true }
> {
  const getter = options?.provider?.getResendContactImport ?? getResendContactImport;
  await renewLaunchLease(job);
  const remote = await getter(importId);
  if (remote.status === "completed") {
    if ((remote.counts?.failed ?? 0) > 0) {
      return { ok: false, error: `Contact import completed with ${remote.counts.failed} failed rows.` };
    }
    return { ok: true, counts: remote.counts ?? {} };
  }
  if (remote.status === "failed") {
    return { ok: false, error: "Provider contact import failed." };
  }
  await query(
    `UPDATE launch_job_imports
        SET status = 'in_progress', updated_at = NOW()
      WHERE id = $1`,
    [importRowId],
  );
  await renewLaunchLease(job);
  return { pending: true };
}

async function allImportsReady(
  jobId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const imports = await query<{ status: string; counts_json: { failed?: number } | null; last_error: string | null }>(
    `SELECT status, counts_json, last_error FROM launch_job_imports WHERE launch_job_id = $1`,
    [jobId],
  );
  if (!imports.rows.length) return { ok: true };
  for (const row of imports.rows) {
    if (row.status !== "completed") {
      return { ok: false, error: `Import chunk not completed (status=${row.status}).` };
    }
    if ((row.counts_json?.failed ?? 0) > 0) {
      return { ok: false, error: `Import chunk has ${row.counts_json?.failed} failed contacts.` };
    }
  }
  return { ok: true };
}

async function syncChunkViaSequentialFallback(
  job: LaunchJobRow,
  segmentId: string,
  recipients: Array<{ email: string; contact_id: string | null; first_name: string; last_name: string }>,
  options?: ProcessOptions,
): Promise<void> {
  for (const row of recipients) {
    const contact = await (options?.provider?.upsertResendContact ?? upsertResendContact)({
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
    });
    await (options?.provider?.addContactToSegment ?? addContactToSegment)(contact.id, segmentId);
    if (row.contact_id) {
      await query(`UPDATE contacts SET provider_contact_id = $1, updated_at = NOW() WHERE id = $2`, [
        contact.id,
        row.contact_id,
      ]);
    }
  }
}

/**
 * Process one bounded chunk for a launch job.
 * Uses Resend CSV import per chunk (tracked in launch_job_imports); fails closed on import errors
 * except a tiny sequential fallback when chunk_size <= 20.
 */
export async function processLaunchJobChunk(
  job: LaunchJobRow,
  options?: ProcessOptions,
): Promise<{ done: boolean; advanced: number; status: string }> {
  const campaign = await loadCampaign(job.campaign_id);
  if (!campaign) {
    return failJob(job, "Campaign missing", { releaseVolume: true });
  }

  const live = options?.live ?? liveSendAllowed();
  const identity = loadSendingIdentity();
  const snapshot = (job.snapshot_json ?? null) as LaunchSnapshot | null;
  const htmlBody = snapshot?.html_body ?? campaign.html_body;
  const textBody = snapshot?.text_body ?? campaign.text_body;
  const footered = applyComplianceFooter(htmlBody, textBody, identity, { broadcast: true });

  if (
    job.status === "submission_unknown" ||
    job.status === "reconciling" ||
    job.status === "submitting" ||
    job.status === "ready_to_submit"
  ) {
    return finalizeBroadcastSubmission(job, campaign, footered, live, options);
  }

  const recipients = await query<{
    id: string;
    email: string;
    contact_id: string | null;
    first_name: string;
    last_name: string;
  }>(
    `SELECT cr.id, cr.email, cr.contact_id,
            COALESCE(cr.first_name, '') AS first_name,
            COALESCE(cr.last_name, '') AS last_name
       FROM campaign_recipients cr
      WHERE cr.campaign_id = $1
      ORDER BY cr.id
      OFFSET $2 LIMIT $3`,
    [job.campaign_id, job.cursor_offset, job.chunk_size],
  );

  if (!recipients.rows.length || job.cursor_offset >= job.total_recipients) {
    const imports = await allImportsReady(job.id);
    if (!imports.ok) {
      return failJob(job, imports.error, { manualReview: true });
    }
    return finalizeBroadcastSubmission(job, campaign, footered, live, options);
  }

  const guard = await preflightIrreversibleOp(job);
  if (!guard.ok) return guard.result;

  let segmentId = job.provider_segment_id || campaign.provider_segment_id;
  if (!segmentId && live && job.live_mode) {
    const createGuard = await preflightIrreversibleOp(job);
    if (!createGuard.ok) return createGuard.result;
    const segment = await (options?.provider?.createResendSegment ?? createResendSegment)(
      `SendStack ${campaign.id}`,
    );
    segmentId = segment.id;
    const updated = await fenceUpdate(job, `provider_segment_id = $1`, [segmentId]);
    if (!updated) return { done: false, advanced: 0, status: job.status };
    await query(`UPDATE campaigns SET provider_segment_id = $1, updated_at = NOW() WHERE id = $2`, [
      segmentId,
      campaign.id,
    ]);
  }

  const chunkIndex = Math.floor(job.cursor_offset / Math.max(1, job.chunk_size));
  if (live && job.live_mode && segmentId) {
    const existingImport = await query<{
      id: string;
      provider_import_id: string | null;
      status: string;
    }>(
      `SELECT id, provider_import_id, status
         FROM launch_job_imports
        WHERE launch_job_id = $1 AND chunk_index = $2`,
      [job.id, chunkIndex],
    );

    let importRow = existingImport.rows[0];
    if (!importRow) {
      const importRecordId = makeId("lji");
      await query(
        `INSERT INTO launch_job_imports
           (id, launch_job_id, chunk_index, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', NOW(), NOW())
         ON CONFLICT (launch_job_id, chunk_index) DO NOTHING`,
        [importRecordId, job.id, chunkIndex],
      );
      const reloaded = await query<{ id: string; provider_import_id: string | null; status: string }>(
        `SELECT id, provider_import_id, status FROM launch_job_imports
          WHERE launch_job_id = $1 AND chunk_index = $2`,
        [job.id, chunkIndex],
      );
      importRow = reloaded.rows[0];
    }

    if (importRow && importRow.status !== "completed") {
      let providerImportId = importRow.provider_import_id;
      if (!providerImportId) {
        const csv = [
          "email,first_name,last_name",
          ...recipients.rows.map((row) =>
            [row.email, JSON.stringify(row.first_name), JSON.stringify(row.last_name)].join(","),
          ),
        ].join("\n");
        try {
          const importGuard = await preflightIrreversibleOp(job);
          if (!importGuard.ok) return importGuard.result;
          const audienceGuard = await enforcePreparedAudience(job);
          if (!audienceGuard.ok) return audienceGuard.result;
          const imported = await (options?.provider?.importResendContactsCsv ?? importResendContactsCsv)({
            csv,
            segmentId,
          });
          providerImportId = imported.id;
          await query(
            `UPDATE launch_job_imports
                SET provider_import_id = $1, status = 'queued', updated_at = NOW()
              WHERE id = $2`,
            [providerImportId, importRow.id],
          );
          // Observability only: never overwrite a prior provider_import_id with a later chunk.
          await fenceUpdate(
            job,
            `provider_import_id = COALESCE(provider_import_id, $1)`,
            [providerImportId],
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Contact import failed";
          const allowFallback =
            job.chunk_size <= SEQUENTIAL_FALLBACK_MAX_CHUNK && live && job.live_mode;
          if (!allowFallback) {
            await query(
              `UPDATE launch_job_imports
                  SET status = 'failed', last_error = $1, updated_at = NOW()
                WHERE id = $2`,
              [message.slice(0, 500), importRow.id],
            );
            return failJob(
              job,
              `Contact import API failed for chunk ${chunkIndex}: ${message}`,
              { manualReview: true },
            );
          }
          await syncChunkViaSequentialFallback(job, segmentId, recipients.rows, options);
          await query(
            `UPDATE launch_job_imports
                SET status = 'completed',
                    counts_json = $1::jsonb,
                    last_error = $2,
                    updated_at = NOW()
              WHERE id = $3`,
            [
              JSON.stringify({ total: recipients.rows.length, failed: 0, fallback: "sequential" }),
              `Import API failed; used sequential fallback: ${message}`.slice(0, 500),
              importRow.id,
            ],
          );
          providerImportId = null;
        }
      }

      if (providerImportId) {
        const polled = await pollContactImportOnce(job, providerImportId, importRow.id, options);
        if ("pending" in polled && polled.pending) {
          return { done: false, advanced: 0, status: "running" };
        }
        if ("ok" in polled && !polled.ok) {
          await query(
            `UPDATE launch_job_imports
                SET status = 'failed', last_error = $1, updated_at = NOW()
              WHERE id = $2`,
            [polled.error.slice(0, 500), importRow.id],
          );
          return failJob(job, polled.error, { manualReview: true });
        }
        if (!("ok" in polled) || !polled.ok) {
          return { done: false, advanced: 0, status: "running" };
        }
        await query(
          `UPDATE launch_job_imports
              SET status = 'completed', counts_json = $1::jsonb, updated_at = NOW()
            WHERE id = $2`,
          [JSON.stringify(polled.counts), importRow.id],
        );
      }
    }
  }

  const advanced = recipients.rows.length;
  const nextOffset = job.cursor_offset + advanced;
  const advancedOk = await fenceUpdate(
    job,
    `cursor_offset = $1,
     lease_expires_at = NOW() + ($2 || ' seconds')::interval`,
    [nextOffset, String(LAUNCH_LEASE_SECONDS)],
  );
  if (!advancedOk) return { done: false, advanced: 0, status: job.status };

  if (nextOffset >= job.total_recipients) {
    const imports = await allImportsReady(job.id);
    if (!imports.ok) {
      return failJob(job, imports.error, { manualReview: true });
    }
    return finalizeBroadcastSubmission(
      { ...job, cursor_offset: nextOffset, provider_segment_id: segmentId ?? job.provider_segment_id },
      campaign,
      footered,
      live,
      options,
    );
  }
  return { done: false, advanced, status: "running" };
}

async function finalizeBroadcastSubmission(
  job: LaunchJobRow,
  campaign: CampaignLaunchRow,
  footered: { html: string; text: string },
  live: boolean,
  options?: ProcessOptions,
): Promise<{ done: boolean; advanced: number; status: string }> {
  // Sandbox completion only when the job was never live.
  if (!job.live_mode) {
    if (live && liveSendAllowed()) {
      // Defensive: non-live job should not flip to live mid-flight.
    }
    await fenceUpdate(job, `status = 'completed', terminal_reason = 'sandbox_completed', lease_expires_at = NOW()`, []);
    await query(
      `UPDATE campaigns
          SET status = 'completed',
              completed_at = COALESCE(completed_at, NOW()),
              provider_status = 'sandbox_completed',
              updated_at = NOW()
        WHERE id = $1`,
      [campaign.id],
    );
    await query(
      `UPDATE campaign_recipients
          SET status = 'sent', sent_at = COALESCE(sent_at, NOW())
        WHERE campaign_id = $1 AND status IN ('queued', 'processing')`,
      [campaign.id],
    );
    await consumeDailyReservationsForCampaign(campaign.id);
    return { done: true, advanced: 0, status: "completed" };
  }

  if (!live || !liveSendAllowed()) {
    return failJob(
      job,
      "Live mode job cannot finalize: live sending is disabled.",
      { manualReview: true },
    );
  }

  const identity = loadSendingIdentity();
  const snapshot = (job.snapshot_json ?? null) as LaunchSnapshot | null;
  // Prefer fresh DB values after long import/chunk work — avoid stale in-memory ids.
  let workingJob = (await loadJobById(job.id)) ?? job;
  let broadcastId =
    (await loadFreshProviderBroadcastId(workingJob.id, campaign.id)) ||
    workingJob.provider_broadcast_id ||
    campaign.provider_broadcast_id;
  const segmentId = workingJob.provider_segment_id || campaign.provider_segment_id;
  if (!segmentId) {
    return failJob(workingJob, "Missing segment id", { releaseVolume: !broadcastId });
  }

  const getBroadcast = options?.provider?.getResendBroadcast ?? getResendBroadcast;
  const createDraft = options?.provider?.createResendBroadcastDraft ?? createResendBroadcastDraft;
  const sendBroadcast = options?.provider?.sendResendBroadcast ?? sendResendBroadcast;

  if (!broadcastId) {
    const createGuard = await preflightIrreversibleOp(workingJob);
    if (!createGuard.ok) return createGuard.result;
    const draft = await createDraft({
      segmentId,
      fromName: snapshot?.from_name ?? campaign.from_name,
      fromEmail: snapshot?.from_email || identity.fromEmail || campaign.from_email,
      replyTo: snapshot?.reply_to_email || identity.replyToEmail || undefined,
      subject: snapshot?.subject ?? campaign.subject,
      html: toResendBroadcastHtml(footered.html),
      text: toResendBroadcastText(footered.text),
      name: `campaign:${campaign.id}`,
    });
    broadcastId = draft.id;
    // Persist BEFORE send — critical for ambiguous submission recovery.
    const persisted = await fenceUpdate(workingJob, `provider_broadcast_id = $1`, [broadcastId]);
    if (!persisted) return { done: false, advanced: 0, status: workingJob.status };
    await query(
      `UPDATE campaigns
          SET provider_broadcast_id = $1, provider_status = 'draft', cancellable = TRUE, updated_at = NOW()
        WHERE id = $2`,
      [broadcastId, campaign.id],
    );
  }

  if (
    workingJob.status === "submission_unknown" ||
    workingJob.status === "reconciling" ||
    workingJob.status === "submitting"
  ) {
    try {
      const remote = await getBroadcast(broadcastId);
      if (
        remote.status === "queued" ||
        remote.status === "sending" ||
        remote.status === "sent" ||
        remote.status === "scheduled"
      ) {
        await fenceUpdate(
          workingJob,
          `status = 'completed', terminal_reason = 'provider_accepted', lease_expires_at = NOW()`,
          [],
        );
        await query(
          `UPDATE campaigns
              SET status = 'sending',
                  provider_status = $1,
                  cancellable = TRUE,
                  submission_state = 'accepted',
                  updated_at = NOW()
            WHERE id = $2`,
          [remote.status, campaign.id],
        );
        await query(
          `UPDATE campaign_recipients SET status = 'processing' WHERE campaign_id = $1 AND status = 'queued'`,
          [campaign.id],
        );
        if (workingJob.reservation_batch_id) {
          await consumeDailyReservationsForCampaign(campaign.id);
        }
        return { done: true, advanced: 0, status: "completed" };
      }
      if (remote.status === "draft") {
        // Safe to send once (or retry after a crashed submitting attempt).
      } else if (remote.status === "canceled" || remote.status === "cancelled" || remote.status === "failed") {
        return failJob(workingJob, `Provider broadcast status: ${remote.status}`);
      } else {
        await fenceUpdate(
          workingJob,
          `status = 'reconciling',
           last_error = $1,
           lease_expires_at = NOW()`,
          [`Unknown provider broadcast status: ${remote.status}`],
        );
        return { done: false, advanced: 0, status: "reconciling" };
      }
    } catch (error) {
      // Do not overwrite submission_unknown to failed on timeout / transient errors.
      await fenceUpdate(
        workingJob,
        `status = 'submission_unknown',
         last_error = $1,
         lease_expires_at = NOW()`,
        [error instanceof Error ? error.message : "Broadcast reconcile failed"],
      );
      return { done: false, advanced: 0, status: "submission_unknown" };
    }
  }

  const sendGuard = await preflightIrreversibleOp(workingJob);
  if (!sendGuard.ok) return sendGuard.result;
  const audienceGuard = await enforcePreparedAudience(workingJob);
  if (!audienceGuard.ok) return audienceGuard.result;

  // Reload again immediately before send CAS — broadcast id / cancel may have changed.
  workingJob = (await loadJobById(workingJob.id)) ?? workingJob;
  broadcastId =
    (await loadFreshProviderBroadcastId(workingJob.id, campaign.id)) || broadcastId;
  if (!broadcastId) {
    return failJob(workingJob, "Missing broadcast id before send", { releaseVolume: true });
  }
  if (workingJob.cancel_requested_at) {
    return { done: true, advanced: 0, status: "cancelled" };
  }

  if (
    workingJob.status === "pending" ||
    workingJob.status === "running" ||
    workingJob.status === "submission_unknown" ||
    workingJob.status === "reconciling" ||
    workingJob.status === "submitting"
  ) {
    const ready = await fenceUpdate(workingJob, `status = 'ready_to_submit'`, []);
    if (!ready) return { done: false, advanced: 0, status: workingJob.status };
    workingJob = { ...workingJob, status: "ready_to_submit" };
  }

  if (!workingJob.lease_owner) {
    return { done: false, advanced: 0, status: workingJob.status };
  }

  const cas = await query<LaunchJobRow>(
    `UPDATE launch_jobs
        SET status = 'submitting', updated_at = NOW()
      WHERE id = $1
        AND lease_owner = $2
        AND lease_generation = $3
        AND status IN ('ready_to_submit', 'running')
        AND cancel_requested_at IS NULL
      RETURNING *`,
    [workingJob.id, workingJob.lease_owner, workingJob.lease_generation],
  );
  if (!cas.rows[0]) {
    // Cancel (or another worker) won the race — do not call provider.
    return { done: true, advanced: 0, status: "cancelled" };
  }
  workingJob = cas.rows[0];

  const sendKey = buildIdempotencyKey(["broadcast-send", campaign.id, broadcastId]);
  try {
    await sendBroadcast(broadcastId, sendKey);
  } catch (error) {
    // Ambiguous: do not release volume; keep reserved until reconcile confirms.
    await fenceUpdate(
      workingJob,
      `status = 'submission_unknown',
       last_error = $1`,
      [error instanceof Error ? error.message : "Ambiguous broadcast submission"],
    );
    await query(
      `UPDATE campaigns
          SET status = 'submission_unknown',
              provider_status = 'submission_unknown',
              submission_state = 'unknown',
              cancellable = TRUE,
              updated_at = NOW()
        WHERE id = $1`,
      [campaign.id],
    );
    await query(
      `UPDATE campaign_recipients
          SET status = 'submission_unknown'
        WHERE campaign_id = $1 AND status IN ('queued', 'processing')`,
      [campaign.id],
    );
    return { done: false, advanced: 0, status: "submission_unknown" };
  }

  const completed = await fenceUpdate(
    workingJob,
    `status = 'completed', terminal_reason = 'broadcast_sent', lease_expires_at = NOW()`,
    [],
  );
  if (!completed) {
    // Lease lost after provider acceptance — do not overwrite a newer cancellation.
    // Leave honest uncertain state; another tick/reconcile can confirm.
    return { done: false, advanced: 0, status: "submission_unknown" };
  }
  await query(
    `UPDATE campaigns
        SET status = 'sending',
            provider_status = 'queued',
            submission_state = 'accepted',
            cancellable = TRUE,
            launch_lock_token = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [campaign.id],
  );
  await query(
    `UPDATE campaign_recipients SET status = 'processing' WHERE campaign_id = $1 AND status = 'queued'`,
    [campaign.id],
  );
  if (workingJob.reservation_batch_id) {
    await consumeDailyReservationsForCampaign(campaign.id);
  }
  return { done: true, advanced: 0, status: "completed" };
}

export async function requestLaunchCancel(campaignId: string): Promise<{
  campaignStatus: string;
  providerCancelled: boolean | null;
  error?: string;
}> {
  const campaign = await query<{
    id: string;
    status: string;
    provider_broadcast_id: string | null;
    cancellable: boolean;
  }>(`SELECT id, status, provider_broadcast_id, cancellable FROM campaigns WHERE id = $1`, [campaignId]);
  const row = campaign.rows[0];
  if (!row) throw new Error("Campaign not found.");

  const activeJobs = await query<{ id: string; status: string; provider_broadcast_id: string | null }>(
    `SELECT id, status, provider_broadcast_id FROM launch_jobs
      WHERE campaign_id = $1
        AND status IN ('pending', 'running', 'ready_to_submit', 'submitting', 'reconciling', 'submission_unknown')`,
    [campaignId],
  );
  const submittingBegun = activeJobs.rows.some(
    (job) => job.status === "submitting" || job.status === "submission_unknown",
  );
  const freshBroadcastId =
    activeJobs.rows.find((job) => job.provider_broadcast_id)?.provider_broadcast_id ||
    row.provider_broadcast_id;
  // Draft broadcast ids alone are not "accepted"; only submitting / ambiguous submit is uncertain.
  const broadcastAcceptedOrSubmitting =
    submittingBegun || row.status === "submission_unknown";

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE campaigns
          SET status = 'cancel_requested',
              provider_status = 'cancel_requested',
              updated_at = NOW()
        WHERE id = $1`,
      [campaignId],
    );
    // Pre-submit active jobs can be cancelled outright.
    await client.query(
      `UPDATE launch_jobs
          SET status = 'cancelled',
              cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
              terminal_reason = COALESCE(terminal_reason, 'cancel_requested'),
              lease_owner = NULL,
              lease_expires_at = NOW(),
              updated_at = NOW()
        WHERE campaign_id = $1
          AND status IN ('pending', 'running', 'ready_to_submit', 'reconciling', 'submission_unknown')`,
      [campaignId],
    );
    // Already submitting: record cancel intent without claiming the send was stopped.
    await client.query(
      `UPDATE launch_jobs
          SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
              updated_at = NOW()
        WHERE campaign_id = $1
          AND status = 'submitting'`,
      [campaignId],
    );
    if (broadcastAcceptedOrSubmitting) {
      await client.query(
        `UPDATE campaign_recipients
            SET status = 'outcome_pending'
          WHERE campaign_id = $1 AND status IN ('queued', 'processing', 'submission_unknown', 'cancel_requested')`,
        [campaignId],
      );
    } else {
      await client.query(
        `UPDATE campaign_recipients
            SET status = 'cancel_requested'
          WHERE campaign_id = $1 AND status IN ('queued', 'processing', 'submission_unknown')`,
        [campaignId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // Prefer fresh broadcast id from launch_jobs after the cancel transaction.
  const broadcastId =
    (await loadFreshProviderBroadcastId(activeJobs.rows[0]?.id, campaignId)) || freshBroadcastId;

  if (broadcastId && liveSendAllowed()) {
    try {
      await cancelResendBroadcast(broadcastId);
      // Confirmed provider cancel path: terminalize unsent outcome_pending / cancel_requested.
      await query(
        `UPDATE campaign_recipients
            SET status = 'cancelled'
          WHERE campaign_id = $1
            AND status IN ('cancel_requested', 'outcome_pending')`,
        [campaignId],
      );
      await reconcileCampaignAfterCancel(campaignId);
      return { campaignStatus: "cancel_requested", providerCancelled: true };
    } catch (error) {
      await query(
        `UPDATE campaigns
            SET provider_status = 'cancel_failed', cancellable = FALSE, updated_at = NOW()
          WHERE id = $1`,
        [campaignId],
      );
      return {
        campaignStatus: "cancel_requested",
        providerCancelled: false,
        error: error instanceof Error ? error.message : "Provider cancel failed",
      };
    }
  }

  if (broadcastAcceptedOrSubmitting) {
    // Honest uncertain/pending: do not claim the send was stopped.
    return {
      campaignStatus: "cancel_requested",
      providerCancelled: null,
      error: broadcastId
        ? "Cancel requested after submit began; provider cancel skipped (live send disabled)."
        : "Cancel requested after submit began; provider outcome still pending.",
    };
  }

  await query(`UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1`, [campaignId]);
  return { campaignStatus: "paused", providerCancelled: null };
}

export async function reconcileCampaignAfterCancel(campaignId: string): Promise<void> {
  const campaign = await query<{ status: string }>(
    `SELECT status FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const campaignStatus = campaign.rows[0]?.status;
  if (
    !campaignStatus ||
    !["cancel_requested", "cancelled", "partially_sent"].includes(campaignStatus)
  ) {
    // Not in a cancellation flow (e.g. sending/completed) — no-op.
    return;
  }

  const stats = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status`,
    [campaignId],
  );
  const counts = Object.fromEntries(stats.rows.map((row) => [row.status, Number(row.count)]));
  const sentLike =
    (counts.sent ?? 0) + (counts.delayed ?? 0) + (counts.bounced ?? 0) + (counts.complained ?? 0);
  const pending =
    (counts.cancel_requested ?? 0) +
    (counts.outcome_pending ?? 0) +
    (counts.queued ?? 0) +
    (counts.processing ?? 0);

  if (pending === 0 && sentLike > 0) {
    await query(
      `UPDATE campaigns
          SET status = 'partially_sent', completed_at = COALESCE(completed_at, NOW()), cancellable = FALSE, updated_at = NOW()
        WHERE id = $1
          AND status IN ('cancel_requested', 'cancelled', 'partially_sent')`,
      [campaignId],
    );
  } else if (pending === 0 && sentLike === 0) {
    await query(
      `UPDATE campaign_recipients SET status = 'cancelled'
        WHERE campaign_id = $1 AND status IN ('cancel_requested', 'outcome_pending')`,
      [campaignId],
    );
    await query(
      `UPDATE campaigns
          SET status = 'cancelled', completed_at = COALESCE(completed_at, NOW()), cancellable = FALSE, updated_at = NOW()
        WHERE id = $1
          AND status IN ('cancel_requested', 'cancelled', 'partially_sent')`,
      [campaignId],
    );
  }
}

/**
 * Bounded time-budget worker loop. Keeps processing the same claimed job until done or budget
 * exhausted; expires the lease immediately when yielding an incomplete job so another tick can continue.
 */
export async function runLaunchWorkerTick(input: {
  workerId: string;
  timeBudgetMs?: number;
  maxChunks?: number;
  provider?: Partial<ResendProvider>;
  live?: boolean;
}): Promise<{
  claimed: boolean;
  launch_job_id: string | null;
  campaign_id: string | null;
  done: boolean;
  advanced: number;
  status: string | null;
  chunks: number;
}> {
  const timeBudgetMs = input.timeBudgetMs ?? 20_000;
  const maxChunks = input.maxChunks ?? 5;
  const started = Date.now();
  const job = await claimLaunchJob(input.workerId);
  if (!job) {
    return {
      claimed: false,
      launch_job_id: null,
      campaign_id: null,
      done: true,
      advanced: 0,
      status: null,
      chunks: 0,
    };
  }

  let current = job;
  let totalAdvanced = 0;
  let chunks = 0;
  let lastStatus = job.status;
  let done = false;

  while (chunks < maxChunks && Date.now() - started < timeBudgetMs) {
    // Yield before starting another provider-heavy chunk when budget is nearly exhausted.
    if (Date.now() - started >= timeBudgetMs - PROVIDER_OP_MIN_BUDGET_MS) {
      break;
    }
    await renewLaunchLease(current);
    try {
      const result = await processLaunchJobChunk(current, {
        provider: input.provider,
        live: input.live,
      });
      chunks += 1;
      totalAdvanced += result.advanced;
      lastStatus = result.status;
      done = result.done;

      const refreshed = await loadJobById(current.id);
      if (!refreshed) break;
      current = refreshed;

      if (result.done && result.status !== "submission_unknown" && result.status !== "reconciling") {
        break;
      }
      if (result.status === "submission_unknown" || result.status === "reconciling") {
        if (Date.now() - started >= timeBudgetMs - PROVIDER_OP_MIN_BUDGET_MS) break;
        continue;
      }
      if (result.advanced === 0 && !result.done) {
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Launch worker chunk failed";
      await scheduleRetry(current, message);
      lastStatus = "pending";
      done = false;
      break;
    }
  }

  if (!done || lastStatus === "submission_unknown" || lastStatus === "reconciling") {
    await expireLease(current);
  }

  return {
    claimed: true,
    launch_job_id: job.id,
    campaign_id: job.campaign_id,
    done,
    advanced: totalAdvanced,
    status: lastStatus,
    chunks,
  };
}

/** In-process helper for tests: run a job to completion with an optional fake provider. */
export async function runLaunchJobToCompletion(
  jobId: string,
  options?: { provider?: Partial<ResendProvider>; live?: boolean; maxChunks?: number },
): Promise<string> {
  let status = "pending";
  const workerId = `test_${makeId("w")}`;
  for (let i = 0; i < (options?.maxChunks ?? 10_000); i += 1) {
    const leased = await query<LaunchJobRow>(
      `UPDATE launch_jobs
          SET status = CASE WHEN status IN ('pending') THEN 'running' ELSE status END,
              lease_owner = $1,
              lease_generation = lease_generation + 1,
              lease_expires_at = NOW() + ($2 || ' seconds')::interval,
              updated_at = NOW()
        WHERE id = $3
        RETURNING *`,
      [workerId, String(LAUNCH_LEASE_SECONDS), jobId],
    );
    const row = leased.rows[0];
    if (!row) throw new Error("Launch job missing");
    if (["completed", "failed", "cancelled", "manual_review"].includes(row.status)) {
      return row.status;
    }
    const result = await processLaunchJobChunk(row, options);
    status = result.status;
    if (result.done && status !== "submission_unknown" && status !== "reconciling") return status;
    if (status === "submission_unknown" || status === "reconciling") {
      const againRow = await loadJobById(jobId);
      if (!againRow) return status;
      const again = await processLaunchJobChunk(
        {
          ...againRow,
          lease_owner: workerId,
          lease_generation: againRow.lease_generation,
        },
        options,
      );
      return again.status;
    }
  }
  return status;
}
