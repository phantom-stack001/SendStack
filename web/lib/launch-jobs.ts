import { applyComplianceFooter } from "./compliance-footer";
import { config } from "./config";
import {
  consumeDailyReservationsForCampaign,
  releaseDailyReservationsForCampaign,
  reserveDailyVolumeBatch,
} from "./daily-volume";
import { getPool, query } from "./db";
import { withSubmitBarrier } from "./submit-barrier";
import { assertDeliveryHealthAllowsSubmit, ensureDeliveryHealthBlock } from "./delivery-health";
import { makeId } from "./ids";
import { buildIdempotencyKey, liveSendAllowed, smtpHourlyLimit } from "./live-send";
import { sendSmtpEmail, smtpAcceptanceAmbiguous, type SmtpEmailInput } from "./providers/smtp";
import { loadSendingIdentity } from "./sending-identity";
import { isSpecialUseRecipientDomain, validateLiveRecipient } from "./recipients";
import { renderTemplate } from "./templates";

export const DEFAULT_LAUNCH_CHUNK_SIZE = 5;
export const LAUNCH_LEASE_SECONDS = 60;
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
  submit_attempted_at?: string | null;
};

/**
 * The worker sends the frozen snapshot bytes. It does not reload sender identity
 * or re-render campaign content. Empty text is still a frozen snapshot.
 */
function frozenLaunchContent(
  snapshot: LaunchSnapshot | null,
  campaign: CampaignLaunchRow,
): { html: string; text: string } {
  if (snapshot && typeof snapshot.html_body === "string" && typeof snapshot.text_body === "string") {
    return { html: snapshot.html_body, text: snapshot.text_body };
  }
  return applyComplianceFooter(campaign.html_body, campaign.text_body, loadSendingIdentity());
}

export type SmtpSendFn = (input: SmtpEmailInput) => Promise<{ id: string; accepted: boolean }>;

type ProcessOptions = {
  /** Test seam: inject a fake SMTP sender (never opens a socket). */
  sendEmail?: SmtpSendFn;
  live?: boolean;
  /** Test seam: runs after SMTP accepts a message, before local finalization of that row. */
  afterProviderAccepted?: () => Promise<void>;
  /** Test seam: runs before the submit barrier, so a concurrent suppression can commit. */
  beforeSubmitBarrier?: () => Promise<void>;
  /** Test seam: runs after the job row is marked completed. */
  afterCompleted?: () => Promise<void>;
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
 * Does not open SMTP — HTTP launch must return promptly.
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
 * and set-based volume reservations. Never opens SMTP.
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
    await ensureDeliveryHealthBlock({
      kind: "manual_review",
      detail: "Launch job exceeded max attempts",
      relatedEntityType: "launch_job",
      relatedEntityId: job.id,
    }).catch(() => undefined);
    return null;
  }
  return job;
}

/**
 * The lease identity a worker acquired at claim time.
 *
 * A fencing token is only a fence if it is pinned. Reloading a job row also
 * reloads `lease_owner`/`lease_generation`, which would make every subsequent
 * compare-and-swap compare the database against itself — a worker whose lease
 * had been stolen would silently regain write authority and could submit the
 * same broadcast a second time. Reloads must therefore keep the claimed values.
 */
export type LeaseFence = {
  lease_owner: string | null;
  lease_generation: number;
};

export function leaseFenceOf(job: Pick<LaunchJobRow, "lease_owner" | "lease_generation">): LeaseFence {
  return { lease_owner: job.lease_owner, lease_generation: job.lease_generation };
}

/** Re-apply the pinned lease identity to a freshly loaded row. */
function withFence(row: LaunchJobRow, fence: LeaseFence): LaunchJobRow {
  return { ...row, lease_owner: fence.lease_owner, lease_generation: fence.lease_generation };
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
    await ensureDeliveryHealthBlock({
      kind: "manual_review",
      detail: errorMessage,
      relatedEntityType: "launch_job",
      relatedEntityId: job.id,
    }).catch(() => undefined);
    return;
  }
  const delay = retryBackoffSeconds(job.attempt_count);
  // The WHERE clause is the state machine: a post-submit status or a recorded
  // attempt can never be moved back to pending, even if the TypeScript caller
  // passes a stale in-memory row. The 0007 trigger rejects the same transition.
  await query(
    `UPDATE launch_jobs
        SET status = 'pending',
            last_error = $1,
            next_retry_at = NOW() + ($2 || ' seconds')::interval,
            lease_expires_at = NOW(),
            lease_owner = NULL,
            updated_at = NOW()
      WHERE id = $3
        AND lease_owner = $4
        AND lease_generation = $5
        AND submit_attempted_at IS NULL
        AND status IN ('pending', 'running', 'ready_to_submit')`,
    [errorMessage.slice(0, 500), String(delay), job.id, job.lease_owner, job.lease_generation],
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
        SET status = CASE
              WHEN status IN (
                'submission_unknown', 'cancel_requested', 'cancelled', 'paused', 'partially_sent'
              ) THEN status
              ELSE 'failed'
            END,
            provider_status = $1,
            cancellable = FALSE,
            updated_at = NOW()
      WHERE id = $2`,
    [status, job.campaign_id],
  );
  if (options?.releaseVolume && !job.provider_broadcast_id) {
    await releaseDailyReservationsForCampaign(job.campaign_id, true);
  }
  if (options?.manualReview || status === "failed") {
    await ensureDeliveryHealthBlock({
      kind: options?.manualReview ? "manual_review" : "unresolved_launch_job",
      detail: reason,
      relatedEntityType: "launch_job",
      relatedEntityId: job.id,
    }).catch(() => undefined);
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

async function withinSmtpHourlyLimit(): Promise<boolean> {
  const limit = smtpHourlyLimit();
  const used = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM messages
      WHERE status IN ('submitted', 'submission_unknown', 'delivered', 'delayed', 'bounced', 'complained')
        AND created_at >= NOW() - INTERVAL '1 hour'`,
  );
  return Number(used.rows[0]?.count ?? 0) < limit;
}

async function loadCampaignAttachments(campaignId: string): Promise<
  Array<{ filename: string; contentBase64: string; contentType: string }>
> {
  const result = await query<{ filename: string; content_type: string; content: Buffer }>(
    `SELECT filename, content_type, content
       FROM campaign_attachments
      WHERE campaign_id = $1
        AND COALESCE(blocked, FALSE) = FALSE
        AND lower(filename) NOT LIKE '%.zip'
      ORDER BY created_at ASC`,
    [campaignId],
  );
  return result.rows.map((row) => ({
    filename: row.filename,
    contentType: row.content_type,
    contentBase64: Buffer.from(row.content).toString("base64"),
  }));
}

async function preflightIrreversibleOp(
  job: LaunchJobRow,
): Promise<{ ok: true } | { ok: false; result: { done: boolean; advanced: number; status: string } }> {
  if (emergencyStopEnabled()) {
    await fenceUpdate(
      job,
      `status = CASE WHEN status IN ('pending', 'running') THEN 'pending' ELSE status END,
       last_error = $1,
       next_retry_at = NOW() + INTERVAL '60 seconds',
       lease_expires_at = NOW(),
       lease_owner = NULL`,
      ["SENDSTACK_EMERGENCY_STOP is enabled."],
    );
    return {
      ok: false,
      result: { done: false, advanced: 0, status: "paused_emergency_stop" },
    };
  }
  const campaign = await query<{ status: string }>(
    `SELECT status FROM campaigns WHERE id = $1`,
    [job.campaign_id],
  );
  const campaignStatus = campaign.rows[0]?.status;
  const cancelIntent =
    Boolean(job.cancel_requested_at) ||
    campaignStatus === "cancel_requested" ||
    campaignStatus === "cancelled" ||
    campaignStatus === "paused";
  if (cancelIntent) {
    // SMTP cancel can only stop unsent recipients. Accepted messages stay submitted.
    await fenceUpdate(
      job,
      `status = 'cancelled',
       cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
       terminal_reason = 'cancel_requested',
       lease_expires_at = NOW(),
       lease_owner = NULL`,
      [],
    );
    await query(
      `UPDATE campaign_recipients
          SET status = 'cancelled'
        WHERE campaign_id = $1
          AND status IN ('queued', 'processing', 'cancel_requested', 'outcome_pending')`,
      [job.campaign_id],
    );
    await query(
      `UPDATE messages
          SET status = 'failed', error = COALESCE(error, 'Cancelled before SMTP submit')
        WHERE campaign_id = $1
          AND status = 'captured'
          AND COALESCE(is_test, FALSE) = FALSE`,
      [job.campaign_id],
    );
    await reconcileCampaignAfterCancel(job.campaign_id);
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

async function completeSandboxLaunch(
  job: LaunchJobRow,
  campaign: CampaignLaunchRow,
  options?: ProcessOptions,
): Promise<{ done: boolean; advanced: number; status: string }> {
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
  await query(
    `UPDATE messages
        SET status = 'submitted'
      WHERE campaign_id = $1
        AND status = 'captured'
        AND COALESCE(is_test, FALSE) = FALSE`,
    [campaign.id],
  );
  await consumeDailyReservationsForCampaign(campaign.id);
  if (options?.afterCompleted) await options.afterCompleted();
  return { done: true, advanced: 0, status: "completed" };
}

async function completeSmtpLaunch(
  job: LaunchJobRow,
  campaign: CampaignLaunchRow,
  options?: ProcessOptions,
): Promise<{ done: boolean; advanced: number; status: string }> {
  await fenceUpdate(job, `status = 'completed', terminal_reason = 'smtp_sent', lease_expires_at = NOW()`, []);
  await query(
    `UPDATE campaigns
        SET status = 'completed',
            completed_at = COALESCE(completed_at, NOW()),
            provider_status = 'smtp_completed',
            submission_state = 'accepted',
            cancellable = FALSE,
            updated_at = NOW()
      WHERE id = $1
        AND status NOT IN ('cancel_requested', 'cancelled', 'paused', 'partially_sent')`,
    [campaign.id],
  );
  if (job.reservation_batch_id) {
    await consumeDailyReservationsForCampaign(campaign.id);
  }
  if (options?.afterCompleted) await options.afterCompleted();
  return { done: true, advanced: 0, status: "completed" };
}

/**
 * Process one bounded chunk: send up to chunk_size unsent messages via SMTP.
 * Sandbox jobs complete without opening a socket.
 */
export async function processLaunchJobChunk(
  job: LaunchJobRow,
  options?: ProcessOptions,
): Promise<{ done: boolean; advanced: number; status: string }> {
  const campaign = await loadCampaign(job.campaign_id);
  if (!campaign) {
    return failJob(job, "Campaign missing", { releaseVolume: true });
  }

  if (job.cancel_requested_at) {
    const cancelGuard = await preflightIrreversibleOp(job);
    if (!cancelGuard.ok) return cancelGuard.result;
  }

  const live = options?.live ?? liveSendAllowed();
  const snapshot = (job.snapshot_json ?? null) as LaunchSnapshot | null;
  const footered = frozenLaunchContent(snapshot, campaign);

  if (!job.live_mode) {
    return completeSandboxLaunch(job, campaign, options);
  }

  if (!live || !liveSendAllowed()) {
    return failJob(job, "Live mode job cannot continue: live sending is disabled.", { manualReview: true });
  }

  const guard = await preflightIrreversibleOp(job);
  if (!guard.ok) return guard.result;

  if (!(await withinSmtpHourlyLimit())) {
    await fenceUpdate(
      job,
      `status = 'pending',
       last_error = $1,
       next_retry_at = NOW() + INTERVAL '60 seconds',
       lease_expires_at = NOW(),
       lease_owner = NULL`,
      ["Hourly SMTP delivery limit reached."],
    );
    return { done: false, advanced: 0, status: "pending" };
  }

  const pending = await query<{
    id: string;
    to_email: string;
    subject: string;
    from_email: string;
    reply_to_email: string | null;
    html_body: string;
    text_body: string;
    unsubscribe_token: string;
    recipient_id: string | null;
    first_name: string;
    last_name: string;
  }>(
    `SELECT m.id, m.to_email, m.subject, m.from_email, m.reply_to_email,
            m.html_body, m.text_body, m.unsubscribe_token, m.recipient_id,
            COALESCE(cr.first_name, '') AS first_name,
            COALESCE(cr.last_name, '') AS last_name
       FROM messages m
       LEFT JOIN campaign_recipients cr ON cr.id = m.recipient_id
      WHERE m.campaign_id = $1
        AND COALESCE(m.is_test, FALSE) = FALSE
        AND m.status IN ('captured', 'failed')
        AND (m.status = 'captured' OR (m.status = 'failed' AND m.provider_id IS NULL))
      ORDER BY m.created_at ASC
      LIMIT $2`,
    [job.campaign_id, job.chunk_size],
  );

  if (!pending.rows.length) {
    const remaining = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM messages
        WHERE campaign_id = $1
          AND COALESCE(is_test, FALSE) = FALSE
          AND status IN ('captured', 'failed')
          AND (status = 'captured' OR (status = 'failed' AND provider_id IS NULL))`,
      [job.campaign_id],
    );
    if (Number(remaining.rows[0]?.count ?? 0) > 0) {
      return { done: false, advanced: 0, status: "running" };
    }
    return completeSmtpLaunch(job, campaign, options);
  }

  const attachments = await loadCampaignAttachments(campaign.id);
  const sendFn = options?.sendEmail ?? sendSmtpEmail;
  const fromName = snapshot?.from_name ?? campaign.from_name;
  const replyTo = snapshot?.reply_to_email || campaign.reply_to_email || undefined;
  let advanced = 0;

  for (const row of pending.rows) {
    const opGuard = await preflightIrreversibleOp(job);
    if (!opGuard.ok) return { ...opGuard.result, advanced };

    if (!(await withinSmtpHourlyLimit())) {
      await fenceUpdate(
        job,
        `status = 'pending',
         last_error = $1,
         next_retry_at = NOW() + INTERVAL '60 seconds',
         lease_expires_at = NOW(),
         lease_owner = NULL`,
        ["Hourly SMTP delivery limit reached."],
      );
      return { done: false, advanced, status: "pending" };
    }

    const unsubscribeUrl = `${config.publicUrl}/u/${row.unsubscribe_token}`;
    const mergeValues = {
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.to_email,
      unsubscribe_url: unsubscribeUrl,
    };
    const htmlBody = renderTemplate(footered.html || row.html_body, mergeValues);
    const textBody = renderTemplate(footered.text || row.text_body, mergeValues);
    const subject = renderTemplate(snapshot?.subject ?? row.subject, mergeValues);

    await query(
      `UPDATE messages
          SET html_body = $1, text_body = $2, subject = $3, diagnostic_json = $4
        WHERE id = $5 AND status IN ('captured', 'failed')`,
      [
        htmlBody,
        textBody,
        subject,
        JSON.stringify({ intent: "smtp", list_unsubscribe: unsubscribeUrl }),
        row.id,
      ],
    );

    let providerAttempted = false;
    try {
      await withSubmitBarrier(async () => {
        if (options?.beforeSubmitBarrier) await options.beforeSubmitBarrier();
        if (emergencyStopEnabled()) {
          throw new Error("SENDSTACK_EMERGENCY_STOP is enabled.");
        }
        if (!liveSendAllowed()) {
          throw new Error("Live sending is disabled.");
        }
        const suppressed = await query<{ email: string }>(
          `SELECT email FROM suppressions WHERE email = $1 LIMIT 1`,
          [row.to_email.toLowerCase()],
        );
        if (suppressed.rows[0]) {
          await query(
            `UPDATE messages SET status = 'suppressed', error = $1 WHERE id = $2`,
            ["Late suppression before SMTP submit", row.id],
          );
          if (row.recipient_id) {
            await query(`UPDATE campaign_recipients SET status = 'suppressed' WHERE id = $1`, [
              row.recipient_id,
            ]);
          }
          return;
        }
        providerAttempted = true;
        await fenceUpdate(job, `status = 'running'`, []);
        const accepted = await sendFn({
          to: row.to_email,
          subject,
          html: htmlBody,
          text: textBody,
          fromName,
          fromEmail: snapshot?.from_email || row.from_email,
          replyTo,
          unsubscribeUrl,
          attachments,
          messageId: row.id,
        });
        if (options?.afterProviderAccepted) await options.afterProviderAccepted();
        await query(
          `UPDATE messages
              SET status = 'submitted',
                  provider_id = $1,
                  error = NULL,
                  diagnostic_json = $2
            WHERE id = $3`,
          [
            accepted.id,
            JSON.stringify({ provider_id: accepted.id, list_unsubscribe: unsubscribeUrl }),
            row.id,
          ],
        );
        if (row.recipient_id) {
          await query(
            `UPDATE campaign_recipients
                SET status = 'sent', sent_at = COALESCE(sent_at, NOW()), error = NULL
              WHERE id = $1`,
            [row.recipient_id],
          );
        }
      });
      advanced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "SMTP delivery failed";
      if (!providerAttempted) {
        // Leave captured so a later tick retries (gates, suppressions, transient setup errors).
        await query(
          `UPDATE messages SET error = $1 WHERE id = $2 AND status IN ('captured', 'failed')`,
          [message.slice(0, 500), row.id],
        );
        break;
      }
      if (smtpAcceptanceAmbiguous(error)) {
        await query(
          `UPDATE messages
              SET status = 'submission_unknown', error = $1
            WHERE id = $2`,
          [message.slice(0, 500), row.id],
        );
        if (row.recipient_id) {
          await query(
            `UPDATE campaign_recipients SET status = 'submission_unknown', error = $1 WHERE id = $2`,
            [message.slice(0, 500), row.recipient_id],
          );
        }
        advanced += 1;
        continue;
      }
      // Definite rejection before acceptance: failed and retryable on a later tick.
      await query(
        `UPDATE messages SET status = 'failed', error = $1 WHERE id = $2`,
        [message.slice(0, 500), row.id],
      );
      if (row.recipient_id) {
        await query(
          `UPDATE campaign_recipients SET status = 'failed', error = $1 WHERE id = $2`,
          [message.slice(0, 500), row.recipient_id],
        );
      }
      advanced += 1;
    }
  }

  const nextOffset = job.cursor_offset + advanced;
  await fenceUpdate(
    job,
    `cursor_offset = $1,
     attempt_count = 0,
     status = 'running',
     lease_expires_at = NOW() + ($2 || ' seconds')::interval`,
    [nextOffset, String(LAUNCH_LEASE_SECONDS)],
  );

  const remaining = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM messages
      WHERE campaign_id = $1
        AND COALESCE(is_test, FALSE) = FALSE
        AND status IN ('captured', 'failed')
        AND (status = 'captured' OR (status = 'failed' AND provider_id IS NULL))`,
    [job.campaign_id],
  );
  if (Number(remaining.rows[0]?.count ?? 0) === 0) {
    return completeSmtpLaunch(
      { ...job, cursor_offset: nextOffset },
      campaign,
      options,
    );
  }
  return { done: false, advanced, status: "running" };
}

export async function requestLaunchCancel(campaignId: string): Promise<{
  campaignStatus: string;
  providerCancelled: boolean | null;
  error?: string;
}> {
  const campaign = await query<{
    id: string;
    status: string;
    cancellable: boolean;
  }>(`SELECT id, status, cancellable FROM campaigns WHERE id = $1`, [campaignId]);
  const row = campaign.rows[0];
  if (!row) throw new Error("Campaign not found.");

  const activeJobs = await query<{ id: string; status: string }>(
    `SELECT id, status FROM launch_jobs
      WHERE campaign_id = $1
        AND status IN ('pending', 'running', 'ready_to_submit', 'submitting', 'reconciling', 'submission_unknown')`,
    [campaignId],
  );
  const acceptedCount = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM messages
      WHERE campaign_id = $1
        AND status IN ('submitted', 'submission_unknown', 'delivered')
        AND COALESCE(is_test, FALSE) = FALSE`,
    [campaignId],
  );
  const submittingBegun = Number(acceptedCount.rows[0]?.count ?? 0) > 0;

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
    await client.query(
      `UPDATE launch_jobs
          SET status = 'cancelled',
              cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
              terminal_reason = COALESCE(terminal_reason, 'cancel_requested'),
              lease_owner = NULL,
              lease_expires_at = NOW(),
              updated_at = NOW()
        WHERE campaign_id = $1
          AND submit_attempted_at IS NULL
          AND status IN ('pending', 'running', 'ready_to_submit')`,
      [campaignId],
    );
    await client.query(
      `UPDATE launch_jobs
          SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
              updated_at = NOW()
        WHERE campaign_id = $1
          AND status IN ('submitting', 'submission_unknown', 'reconciling', 'running')`,
      [campaignId],
    );
    // Stop unsent recipients. Messages already submitted via SMTP cannot be recalled.
    await client.query(
      `UPDATE campaign_recipients
          SET status = 'cancelled'
        WHERE campaign_id = $1
          AND status IN ('queued', 'processing', 'cancel_requested', 'outcome_pending', 'failed')`,
      [campaignId],
    );
    await client.query(
      `UPDATE messages
          SET status = 'failed', error = COALESCE(error, 'Cancelled before SMTP submit')
        WHERE campaign_id = $1
          AND status IN ('captured', 'failed')
          AND provider_id IS NULL
          AND COALESCE(is_test, FALSE) = FALSE`,
      [campaignId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await reconcileCampaignAfterCancel(campaignId);

  if (submittingBegun) {
    const sent = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM messages
        WHERE campaign_id = $1
          AND status IN ('submitted', 'submission_unknown', 'delivered')
          AND COALESCE(is_test, FALSE) = FALSE`,
      [campaignId],
    );
    if (Number(sent.rows[0]?.count ?? 0) > 0) {
      return {
        campaignStatus: "cancel_requested",
        providerCancelled: null,
        error: "Cancel stops unsent recipients only. Messages Spacemail already accepted cannot be recalled.",
      };
    }
  }

  await query(`UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1 AND status = 'cancel_requested'`, [
    campaignId,
  ]);
  return { campaignStatus: "paused", providerCancelled: null };
}

export async function reconcileCampaignAfterCancel(
  campaignId: string,
  sql: { query: typeof query } = { query },
): Promise<void> {
  const campaign = await sql.query<{ status: string }>(
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

  const stats = await sql.query<{ status: string; count: string }>(
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
    await sql.query(
      `UPDATE campaigns
          SET status = 'partially_sent', completed_at = COALESCE(completed_at, NOW()), cancellable = FALSE, updated_at = NOW()
        WHERE id = $1
          AND status IN ('cancel_requested', 'cancelled', 'partially_sent')`,
      [campaignId],
    );
  } else if (pending === 0 && sentLike === 0) {
    await sql.query(
      `UPDATE campaign_recipients SET status = 'cancelled'
        WHERE campaign_id = $1 AND status IN ('cancel_requested', 'outcome_pending')`,
      [campaignId],
    );
    await sql.query(
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
  sendEmail?: SmtpSendFn;
  live?: boolean;
  afterProviderAccepted?: () => Promise<void>;
  afterCompleted?: () => Promise<void>;
  beforeSubmitBarrier?: () => Promise<void>;
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
  if (emergencyStopEnabled()) {
    // Do not even claim: claiming burns an attempt and takes a lease for no purpose.
    return {
      claimed: false,
      launch_job_id: null,
      campaign_id: null,
      done: false,
      advanced: 0,
      status: "paused_emergency_stop",
      chunks: 0,
    };
  }
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

  const claimFence = leaseFenceOf(job);
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
        sendEmail: input.sendEmail,
        live: input.live,
        afterProviderAccepted: input.afterProviderAccepted,
        afterCompleted: input.afterCompleted,
        beforeSubmitBarrier: input.beforeSubmitBarrier,
      });
      chunks += 1;
      totalAdvanced += result.advanced;
      lastStatus = result.status;
      done = result.done;

      const refreshed = await loadJobById(current.id);
      if (!refreshed) break;
      // Keep the claim's lease identity: a refreshed token would let this worker
      // keep writing after another worker legitimately stole the lease.
      current = withFence(refreshed, claimFence);

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
      const fresh = await loadJobById(current.id);
      const row = fresh ? withFence(fresh, claimFence) : current;
      // Per-recipient SMTP: a chunk failure parks the job for retry. Individual
      // messages already accepted stay submitted; unsent rows remain captured/failed.
      if (!["completed", "manual_review", "cancelled"].includes(row.status)) {
        await scheduleRetry(row, message);
        lastStatus = "pending";
      } else {
        lastStatus = row.status;
      }
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
  options?: { sendEmail?: SmtpSendFn; live?: boolean; maxChunks?: number },
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
