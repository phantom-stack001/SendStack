import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/live-send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/live-send")>();
  return {
    ...actual,
    liveSendAllowed: () => true,
  };
});

import { query, resetPool } from "../lib/db";
import {
  claimAndPrepareCampaignLaunch,
  claimLaunchJob,
  processLaunchJobChunk,
  runLaunchWorkerTick,
  type LaunchJobRow,
  type SmtpSendFn,
} from "../lib/launch-jobs";
import { makeId } from "../lib/ids";
import {
  applyTestEnv,
  canConnectToTestDatabase,
  resolveTestDatabaseUrl,
  seedActiveContact,
  seedAdminUser,
  seedDraftCampaign,
  seedList,
  truncateAppTables,
} from "./pg-test-utils";

const testUrl = resolveTestDatabaseUrl();
const dbAvailable = Boolean(testUrl) && (await canConnectToTestDatabase(testUrl as string));

function recordingSmtp(overrides: { failOnce?: boolean; ambiguous?: boolean } = {}) {
  const sends: string[] = [];
  let failed = false;
  const sendEmail: SmtpSendFn = async (input) => {
    if (overrides.failOnce && !failed) {
      failed = true;
      throw new Error("SMTP 550 rejected");
    }
    if (overrides.ambiguous) {
      const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      throw err;
    }
    sends.push(input.to);
    return { id: `smtp_${makeId("m")}`, accepted: true };
  };
  return { sendEmail, sends };
}

async function seedLaunchableCampaign(contactCount = 1) {
  const userId = await seedAdminUser();
  const listId = await seedList();
  for (let i = 0; i < contactCount; i += 1) {
    await seedActiveContact({
      listId,
      email: `safety_${makeId("e")}_${i}@example.com`,
      actorUserId: userId,
    });
  }
  const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
  const { job } = await claimAndPrepareCampaignLaunch({
    campaignId,
    liveMode: true,
    chunkSize: 5,
  });
  return { userId, listId, campaignId, job };
}

async function leaseTo(jobId: string, workerId: string): Promise<LaunchJobRow> {
  const leased = await query<LaunchJobRow>(
    `UPDATE launch_jobs
        SET status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
            lease_owner = $1,
            lease_generation = lease_generation + 1,
            lease_expires_at = NOW() + INTERVAL '60 seconds',
            updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [workerId, jobId],
  );
  return leased.rows[0]!;
}

async function jobRow(jobId: string) {
  const row = await query<{
    status: string;
    terminal_reason: string | null;
    attempt_count: number;
    cursor_offset: number;
  }>(
    `SELECT status, terminal_reason, attempt_count, cursor_offset
       FROM launch_jobs WHERE id = $1`,
    [jobId],
  );
  return row.rows[0]!;
}

describe.skipIf(!dbAvailable)("launch worker SMTP safety", () => {
  beforeAll(async () => {
    applyTestEnv(testUrl as string);
    process.env.SENDSTACK_SMTP_HOST = "mail.spacemail.com";
    process.env.SENDSTACK_SMTP_USERNAME = "news@example.com";
    process.env.SENDSTACK_SMTP_PASSWORD = "secret";
    process.env.SENDSTACK_DELIVERY_MODE = "smtp";
    process.env.SENDSTACK_LIVE_SEND_ENABLED = "true";
    await resetPool();
  });

  beforeEach(async () => {
    await truncateAppTables();
  });

  afterAll(async () => {
    await resetPool();
  });

  it("sends each recipient once through the injected SMTP sender", async () => {
    const { job, campaignId } = await seedLaunchableCampaign(3);
    const { sendEmail, sends } = recordingSmtp();
    const leased = await leaseTo(job.id, "worker_a");
    const result = await processLaunchJobChunk(leased, { sendEmail, live: true });
    expect(result.done).toBe(true);
    expect(sends).toHaveLength(3);
    expect(new Set(sends).size).toBe(3);
    const messages = await query<{ status: string }>(
      `SELECT status FROM messages WHERE campaign_id = $1 AND COALESCE(is_test, FALSE) = FALSE`,
      [campaignId],
    );
    expect(messages.rows.every((row) => row.status === "submitted")).toBe(true);
    expect((await jobRow(job.id)).status).toBe("completed");
  });

  it("does not resend after ambiguous SMTP acceptance", async () => {
    const { job, campaignId } = await seedLaunchableCampaign(1);
    const { sendEmail } = recordingSmtp({ ambiguous: true });
    const leased = await leaseTo(job.id, "worker_a");
    await processLaunchJobChunk(leased, { sendEmail, live: true });
    const messages = await query<{ status: string; provider_id: string | null }>(
      `SELECT status, provider_id FROM messages WHERE campaign_id = $1 AND COALESCE(is_test, FALSE) = FALSE`,
      [campaignId],
    );
    expect(messages.rows[0]?.status).toBe("submission_unknown");

    const { sendEmail: again, sends } = recordingSmtp();
    const leased2 = await leaseTo(job.id, "worker_b");
    await processLaunchJobChunk(leased2, { sendEmail: again, live: true });
    expect(sends).toHaveLength(0);
  });

  it("retries definite SMTP rejection on a later tick", async () => {
    const { job, campaignId } = await seedLaunchableCampaign(1);
    const { sendEmail } = recordingSmtp({ failOnce: true });
    const leased = await leaseTo(job.id, "worker_a");
    await processLaunchJobChunk(leased, { sendEmail, live: true });
    const failed = await query<{ status: string }>(
      `SELECT status FROM messages WHERE campaign_id = $1 AND COALESCE(is_test, FALSE) = FALSE`,
      [campaignId],
    );
    expect(failed.rows[0]?.status).toBe("failed");

    const leased2 = await leaseTo(job.id, "worker_b");
    const result = await processLaunchJobChunk(leased2, { sendEmail, live: true });
    expect(result.done).toBe(true);
    const submitted = await query<{ status: string }>(
      `SELECT status FROM messages WHERE campaign_id = $1 AND COALESCE(is_test, FALSE) = FALSE`,
      [campaignId],
    );
    expect(submitted.rows[0]?.status).toBe("submitted");
  });

  it("claimLaunchJob skips jobs with an active lease", async () => {
    const { job } = await seedLaunchableCampaign(1);
    await leaseTo(job.id, "worker_a");
    const second = await claimLaunchJob("worker_b");
    expect(second).toBeNull();
  });

  it("runLaunchWorkerTick completes a sandbox job without SMTP", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: `sandbox_${makeId("e")}@example.com`, actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    await claimAndPrepareCampaignLaunch({ campaignId, liveMode: false, chunkSize: 5 });
    const { sendEmail, sends } = recordingSmtp();
    const tick = await runLaunchWorkerTick({
      workerId: "tick_sandbox",
      sendEmail,
      live: false,
      timeBudgetMs: 10_000,
    });
    expect(tick.claimed).toBe(true);
    expect(tick.done).toBe(true);
    expect(sends).toHaveLength(0);
  });
});
