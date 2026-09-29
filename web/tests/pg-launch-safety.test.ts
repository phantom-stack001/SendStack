import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/providers/resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providers/resend")>();
  return {
    ...actual,
    // Vitest sets NODE_ENV=test; production liveSendAllowed hard-fails there.
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

type SendLog = { sends: string[]; drafts: number; gets: number };

/** Provider double that records every irreversible call. */
function recordingProvider(overrides: Record<string, unknown> = {}) {
  const log: SendLog = { sends: [], drafts: 0, gets: 0 };
  const provider = {
    createResendSegment: async () => ({ id: `seg_${makeId("s")}` }),
    importResendContactsCsv: async () => ({ id: `imp_${makeId("i")}` }),
    getResendContactImport: async (id: string) => ({
      id,
      status: "completed" as const,
      counts: { failed: 0, total: 1 },
    }),
    createResendBroadcastDraft: async () => {
      log.drafts += 1;
      return { id: `bcast_${makeId("b")}` };
    },
    sendResendBroadcast: async (id: string) => {
      log.sends.push(id);
      return { id };
    },
    getResendBroadcast: async (id: string) => {
      log.gets += 1;
      return { id, status: "draft" as const };
    },
    cancelResendBroadcast: async (id: string) => ({ id }),
    ...overrides,
  };
  return { provider: provider as never, log };
}

async function seedLaunchableCampaign() {
  const userId = await seedAdminUser();
  const listId = await seedList();
  await seedActiveContact({
    listId,
    email: `safety_${makeId("e")}@example.com`,
    actorUserId: userId,
  });
  const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
  const { job } = await claimAndPrepareCampaignLaunch({
    campaignId,
    liveMode: true,
    chunkSize: 50,
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
    lease_owner: string | null;
    lease_generation: number;
  }>(
    `SELECT status, terminal_reason, attempt_count, cursor_offset, lease_owner, lease_generation
       FROM launch_jobs WHERE id = $1`,
    [jobId],
  );
  return row.rows[0]!;
}

describe.skipIf(!dbAvailable)("launch worker duplicate-send safety", () => {
  beforeAll(async () => {
    applyTestEnv(testUrl as string);
    await resetPool();
  });

  beforeEach(async () => {
    await truncateAppTables();
    delete process.env.SENDSTACK_EMERGENCY_STOP;
  });

  afterAll(async () => {
    delete process.env.SENDSTACK_EMERGENCY_STOP;
    await resetPool();
  });

  /**
   * Regression for the lease-fence defect. Status `ready_to_submit` routes straight to
   * the submit path with a broadcast id already persisted, so the only thing standing
   * between a stale worker and a second provider send is the fence. When the fence was
   * re-read from the database on reload, the stale worker adopted the new owner's token
   * and its send CAS succeeded.
   */
  it("a worker whose lease was stolen cannot submit the broadcast", async () => {
    const { job, campaignId } = await seedLaunchableCampaign();
    await query(
      `UPDATE launch_jobs
          SET status = 'ready_to_submit', provider_broadcast_id = 'bcast_fence',
              provider_segment_id = 'seg_existing', cursor_offset = total_recipients
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns SET provider_broadcast_id = 'bcast_fence',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [campaignId],
    );

    // Worker A takes the lease and keeps its pinned fence for the whole tick.
    const workerA = await leaseTo(job.id, "worker_a");
    // Worker B then legitimately steals it (A's lease is treated as expired).
    await leaseTo(job.id, "worker_b");

    const { provider, log } = recordingProvider();
    const result = await processLaunchJobChunk(workerA, { provider, live: true });

    expect(log.sends).toEqual([]);
    expect(result.status).not.toBe("completed");

    const row = await jobRow(job.id);
    expect(row.lease_owner).toBe("worker_b");
  });

  /**
   * Regression for the re-entry defect. The worker enters with status `running`, and the
   * status flips to `submitting` underneath it while it is inside the provider draft
   * call — the real interleaving. The pre-send reload then observes `submitting`, which
   * previously round-tripped back to `ready_to_submit` and re-entered the send CAS.
   */
  it("a status that flips to submitting mid-tick does not re-enter the send path", async () => {
    const { job, campaignId } = await seedLaunchableCampaign();
    await query(
      `UPDATE launch_jobs
          SET status = 'running', provider_segment_id = 'seg_existing',
              cursor_offset = total_recipients
        WHERE id = $1`,
      [job.id],
    );
    await query(`UPDATE campaigns SET provider_segment_id = 'seg_existing' WHERE id = $1`, [
      campaignId,
    ]);

    const leased = await leaseTo(job.id, "worker_flip");
    const { provider, log } = recordingProvider({
      createResendBroadcastDraft: async () => {
        // Another worker commits a submit attempt while this one is in the provider call.
        await query(`UPDATE launch_jobs SET status = 'submitting' WHERE id = $1`, [job.id]);
        return { id: "bcast_flip" };
      },
    });

    const result = await processLaunchJobChunk(leased, { provider, live: true });

    expect(log.sends).toEqual([]);
    expect(result.status).toBe("submitting");
  });

  it("a job already in submitting is never re-submitted", async () => {
    const { job } = await seedLaunchableCampaign();

    // Simulate a committed submit attempt: `submitting` plus a persisted broadcast id.
    await query(
      `UPDATE launch_jobs
          SET status = 'submitting', provider_broadcast_id = 'bcast_already_submitting',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns SET provider_broadcast_id = 'bcast_already_submitting',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [job.campaign_id],
    );

    const leased = await leaseTo(job.id, "worker_resume");
    const { provider, log } = recordingProvider();
    const result = await processLaunchJobChunk(leased, { provider, live: true });

    expect(log.sends).toEqual([]);
    expect(log.drafts).toBe(0);
    expect(result.status).toBe("manual_review");
  });

  it("provider reporting draft after a submit attempt escalates instead of re-sending", async () => {
    const { job } = await seedLaunchableCampaign();
    await query(
      `UPDATE launch_jobs
          SET status = 'submission_unknown', provider_broadcast_id = 'bcast_ambiguous',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns SET provider_broadcast_id = 'bcast_ambiguous',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [job.campaign_id],
    );

    const leased = await leaseTo(job.id, "worker_reconcile");
    // getResendBroadcast returns "draft" by default in the double.
    const { provider, log } = recordingProvider();
    const result = await processLaunchJobChunk(leased, { provider, live: true });

    expect(log.sends).toEqual([]);
    expect(result.status).toBe("manual_review");

    const row = await jobRow(job.id);
    expect(row.status).toBe("manual_review");
    expect(row.terminal_reason).toBe("submit_attempted_provider_reports_draft");

    const block = await query<{ kind: string }>(
      `SELECT kind FROM delivery_health_blocks
        WHERE related_entity_id = $1 AND resolved_at IS NULL AND waived_at IS NULL`,
      [job.id],
    );
    expect(block.rows.map((r) => r.kind)).toContain("manual_review");
  });

  it("a queued provider broadcast still completes without a second send", async () => {
    const { job } = await seedLaunchableCampaign();
    await query(
      `UPDATE launch_jobs
          SET status = 'submission_unknown', provider_broadcast_id = 'bcast_accepted',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns SET provider_broadcast_id = 'bcast_accepted',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [job.campaign_id],
    );

    const leased = await leaseTo(job.id, "worker_accepted");
    const { provider, log } = recordingProvider({
      getResendBroadcast: async (id: string) => ({ id, status: "queued" as const }),
    });
    const result = await processLaunchJobChunk(leased, { provider, live: true });

    expect(log.sends).toEqual([]);
    expect(result.status).toBe("completed");
  });
});

describe.skipIf(!dbAvailable)("launch worker liveness safety", () => {
  beforeAll(async () => {
    applyTestEnv(testUrl as string);
    await resetPool();
  });

  beforeEach(async () => {
    await truncateAppTables();
    delete process.env.SENDSTACK_EMERGENCY_STOP;
  });

  afterAll(async () => {
    delete process.env.SENDSTACK_EMERGENCY_STOP;
    await resetPool();
  });

  it("a cancel requested while submitting reaches a terminal state instead of wedging", async () => {
    const { job, campaignId } = await seedLaunchableCampaign();
    await query(
      `UPDATE launch_jobs
          SET status = 'submitting', provider_broadcast_id = 'bcast_cancel_race',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns SET provider_broadcast_id = 'bcast_cancel_race',
              provider_segment_id = 'seg_existing', status = 'sending'
        WHERE id = $1`,
      [campaignId],
    );

    // Record the same cancel intent the cancel endpoint writes for a submitting job,
    // without invoking the real provider from a test.
    await query(
      `UPDATE launch_jobs SET cancel_requested_at = NOW() WHERE id = $1 AND status = 'submitting'`,
      [job.id],
    );
    const pending = await query<{ cancel_requested_at: string | null }>(
      `SELECT cancel_requested_at FROM launch_jobs WHERE id = $1`,
      [job.id],
    );
    expect(pending.rows[0]?.cancel_requested_at).not.toBeNull();

    // The job must remain claimable so a worker can terminalize it. Previously the
    // claim predicate excluded cancel_requested_at, leaving the row permanently
    // non-terminal, which kept every future launch blocked by the health gate.
    await query(`UPDATE launch_jobs SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      job.id,
    ]);
    const claimed = await claimLaunchJob(makeId("w"));
    expect(claimed?.id).toBe(job.id);

    const { provider: p2, log } = recordingProvider();
    await processLaunchJobChunk(claimed!, { provider: p2, live: true });
    expect(log.sends).toEqual([]);

    const row = await jobRow(job.id);
    expect(row.status).not.toBe("cancelled");
    expect(["manual_review", "submission_unknown", "reconciling", "completed"]).toContain(row.status);
  });

  it("an unconfirmed provider status is not stored as cancellation", async () => {
    const { job, campaignId } = await seedLaunchableCampaign();
    await query(
      `UPDATE launch_jobs
          SET status = 'submitting', provider_broadcast_id = 'bcast_unknown_cancel',
              provider_segment_id = 'seg_existing', cancel_requested_at = NOW()
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns SET status = 'cancel_requested', provider_broadcast_id = 'bcast_unknown_cancel',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [campaignId],
    );
    const leased = await leaseTo(job.id, "worker_unknown_cancel");
    const { provider, log } = recordingProvider({
      getResendBroadcast: async (id: string) => ({ id, status: "unknown" as const }),
    });
    await processLaunchJobChunk(leased, { provider, live: true });
    expect(log.sends).toEqual([]);
    const row = await jobRow(job.id);
    expect(row.status).toBe("reconciling");
    expect(row.status).not.toBe("cancelled");
    const campaign = await query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    expect(campaign.rows[0]?.status).toBe("cancel_requested");
  });

  it("a provider-confirmed cancel is the only path that records cancellation", async () => {
    const { job } = await seedLaunchableCampaign();
    await query(
      `UPDATE launch_jobs
          SET status = 'submitting', provider_broadcast_id = 'bcast_confirmed_cancel',
              provider_segment_id = 'seg_existing', cancel_requested_at = NOW()
        WHERE id = $1`,
      [job.id],
    );
    const leased = await leaseTo(job.id, "worker_confirmed_cancel");
    const { provider, log } = recordingProvider({
      getResendBroadcast: async (id: string) => ({ id, status: "cancelled" as const }),
    });
    await processLaunchJobChunk(leased, { provider, live: true });
    expect(log.sends).toEqual([]);
    const row = await jobRow(job.id);
    expect(row.status).toBe("cancelled");
    expect(row.terminal_reason).toBe("provider_confirmed_cancel");
  });

  it("reconciliation does not move a cancelled campaign back to sending", async () => {
    const { job, campaignId } = await seedLaunchableCampaign();
    await query(
      `UPDATE launch_jobs
          SET status = 'submission_unknown', provider_broadcast_id = 'bcast_stale',
              provider_segment_id = 'seg_existing', cancel_requested_at = NOW(),
              lease_expires_at = NOW() - INTERVAL '1 minute'
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns SET status = 'cancel_requested', provider_broadcast_id = 'bcast_stale',
              provider_segment_id = 'seg_existing'
        WHERE id = $1`,
      [campaignId],
    );
    const { provider, log } = recordingProvider({
      getResendBroadcast: async (id: string) => ({ id, status: "queued" as const }),
    });
    await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      provider,
      timeBudgetMs: 4_000,
      maxChunks: 3,
    });
    expect(log.sends).toEqual([]);
    const campaign = await query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    expect(campaign.rows[0]?.status).toBe("cancel_requested");
    const row = await jobRow(job.id);
    expect(["pending", "running", "ready_to_submit"]).not.toContain(row.status);
  });

  it("sends the frozen snapshot bytes after identity changes", async () => {
    const { job } = await seedLaunchableCampaign();
    const stored = await query<{ snapshot_json: { html_body: string; text_body: string } }>(
      `SELECT snapshot_json FROM launch_jobs WHERE id = $1`,
      [job.id],
    );
    const snapshot = stored.rows[0]!.snapshot_json;
    const originalCompany = process.env.SENDSTACK_COMPANY_NAME;
    process.env.SENDSTACK_COMPANY_NAME = "Changed After Freeze Ltd";
    const drafted: { html?: string; text?: string } = {};
    const { provider } = recordingProvider({
      createResendBroadcastDraft: async (input: { html: string; text?: string }) => {
        drafted.html = input.html;
        drafted.text = input.text;
        return { id: "bcast_snapshot" };
      },
      getResendBroadcast: async (id: string) => ({ id, status: "queued" as const }),
    });
    try {
      await runLaunchWorkerTick({
        workerId: makeId("w"),
        live: true,
        provider,
        timeBudgetMs: 8_000,
        maxChunks: 6,
      });
    } finally {
      process.env.SENDSTACK_COMPANY_NAME = originalCompany;
    }
    const { toResendBroadcastHtml, toResendBroadcastText } = await import("../lib/providers/resend");
    expect(drafted.html).toBe(toResendBroadcastHtml(snapshot.html_body));
    expect(drafted.text).toBe(toResendBroadcastText(snapshot.text_body));
    expect(drafted.html).toContain("Example Co");
    expect(drafted.html).not.toContain("Changed After Freeze");
  });

  it("attempt_count resets when the cursor advances so long launches are not capped", async () => {
    const { job } = await seedLaunchableCampaign();
    await query(`UPDATE launch_jobs SET attempt_count = 20, max_attempts = 25 WHERE id = $1`, [
      job.id,
    ]);

    const leased = await leaseTo(job.id, "worker_progress");
    const { provider } = recordingProvider();
    await processLaunchJobChunk(leased, { provider, live: true });

    const row = await jobRow(job.id);
    expect(row.cursor_offset).toBeGreaterThan(0);
    expect(row.attempt_count).toBe(0);
  });

  it("emergency stop neither claims a job nor terminalizes it", async () => {
    const { job } = await seedLaunchableCampaign();
    process.env.SENDSTACK_EMERGENCY_STOP = "1";

    const { provider, log } = recordingProvider();
    const tick = await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      provider,
      timeBudgetMs: 3_000,
      maxChunks: 3,
    });

    expect(log.sends).toEqual([]);
    expect(tick.claimed).toBe(false);
    expect(tick.status).toBe("paused_emergency_stop");

    const row = await jobRow(job.id);
    expect(row.attempt_count).toBe(0);
    expect(row.terminal_reason).toBeNull();
    expect(row.status).not.toBe("manual_review");
  });

  async function driveToSend(hooks: {
    afterProviderAccepted?: () => Promise<void>;
    afterCompleted?: () => Promise<void>;
    beforeSubmitBarrier?: () => Promise<void>;
    send?: (id: string) => Promise<{ id: string }>;
  }) {
    const seeded = await seedLaunchableCampaign();
    const { provider, log } = recordingProvider({
      getResendBroadcast: async (id: string) => ({ id, status: "queued" as const }),
      ...(hooks.send ? { sendResendBroadcast: hooks.send } : {}),
    });
    const tick = await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      provider,
      timeBudgetMs: 8_000,
      maxChunks: 6,
      afterProviderAccepted: hooks.afterProviderAccepted,
      afterCompleted: hooks.afterCompleted,
      beforeSubmitBarrier: hooks.beforeSubmitBarrier,
    });
    return { ...seeded, provider, log, tick };
  }

  function dbFailure(): Error {
    const error = new Error("simulated postgres failure after provider acceptance");
    (error as { code?: string }).code = "57P01";
    return error;
  }

  it("a database failure after a successful broadcast send cannot send again", async () => {
    const { log, job } = await driveToSend({
      afterProviderAccepted: async () => {
        throw dbFailure();
      },
    });
    expect(log.sends).toHaveLength(1);
    const second = recordingProvider({
      getResendBroadcast: async (id: string) => ({ id, status: "queued" as const }),
    });
    await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      provider: second.provider,
      timeBudgetMs: 4_000,
      maxChunks: 3,
    });
    expect(second.log.sends).toEqual([]);
    expect(log.sends).toHaveLength(1);
    const row = await jobRow(job.id);
    expect(["pending", "running", "ready_to_submit"]).not.toContain(row.status);
  });

  it("an ambiguous provider timeout cannot send again", async () => {
    const sends: string[] = [];
    const { job } = await driveToSend({
      send: async (id: string) => {
        sends.push(id);
        throw new Error("provider timeout: outcome ambiguous");
      },
    });
    expect(sends).toHaveLength(1);
    const second = recordingProvider();
    await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      provider: second.provider,
      timeBudgetMs: 4_000,
      maxChunks: 3,
    });
    expect(second.log.sends).toEqual([]);
    const row = await jobRow(job.id);
    expect(["pending", "running", "ready_to_submit"]).not.toContain(row.status);
  });

  it("a failure after the completion transition cannot reopen the job", async () => {
    const { log, job } = await driveToSend({
      afterCompleted: async () => {
        throw dbFailure();
      },
    });
    expect(log.sends).toHaveLength(1);
    await expect(
      query(
        `UPDATE launch_jobs SET status = 'pending', lease_owner = NULL WHERE id = $1`,
        [job.id],
      ),
    ).rejects.toThrow(/cannot/i);
    const row = await jobRow(job.id);
    expect(row.status).toBe("completed");
  });

  it("a suppression committed immediately before submission prevents the provider call", async () => {
    const { applySuppression } = await import("../lib/suppressions");
    const { log } = await driveToSend({
      beforeSubmitBarrier: async () => {
        const recipient = await query<{ email: string }>(
          `SELECT email FROM campaign_recipients ORDER BY created_at DESC LIMIT 1`,
        );
        await applySuppression(recipient.rows[0]!.email, "manual", "test");
      },
    });
    expect(log.sends).toEqual([]);
  });

  it("a health block committed immediately before submission prevents the provider call", async () => {
    const { log } = await driveToSend({
      beforeSubmitBarrier: async () => {
        await query(
          `INSERT INTO delivery_health_blocks (id, kind, detail, created_at)
           VALUES ($1, 'other', 'emergency health block committed before submission', NOW())`,
          [makeId("dhb")],
        );
      },
    });
    expect(log.sends).toEqual([]);
  }, 20_000);
});
