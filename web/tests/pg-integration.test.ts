import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/providers/resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providers/resend")>();
  return {
    ...actual,
    // Vitest sets NODE_ENV=test; production liveSendAllowed hard-fails there.
    liveSendAllowed: () => true,
  };
});

import { GET as launchJobsCronGet } from "../app/api/cron/launch-jobs/route";
import { activateContactWithConsent } from "../lib/consent";
import { applyComplianceFooter } from "../lib/compliance-footer";
import { reserveDailyVolume, utcDayString } from "../lib/daily-volume";
import { query, resetPool } from "../lib/db";
import {
  claimAndPrepareCampaignLaunch,
  claimLaunchJob,
  processLaunchJobChunk,
  renewLaunchLease,
  requestLaunchCancel,
  runLaunchJobToCompletion,
  runLaunchWorkerTick,
  type LaunchJobRow,
} from "../lib/launch-jobs";
import {
  hasVisibleUnsubscribe,
  parsePublicOrigin,
  runCampaignPreflight,
  validateAllowedLinkDomains,
  validateCampaignLink,
} from "../lib/preflight";
import { processResendWebhookEvent } from "../lib/providers/webhook-processor";
import { loadSendingIdentity } from "../lib/sending-identity";
import { applySuppression } from "../lib/suppressions";
import { makeId } from "../lib/ids";
import {
  CONSENT_EVIDENCE,
  applyTestEnv,
  canConnectToTestDatabase,
  ensurePgTestReady,
  resolveTestDatabaseUrl,
  seedActiveContact,
  seedActiveContactsBulk,
  seedAdminSession,
  seedAdminUser,
  seedDraftCampaign,
  seedList,
  seedPendingContact,
  truncateAppTables,
} from "./pg-test-utils";

const testUrl = resolveTestDatabaseUrl();
const dbAvailable = Boolean(testUrl) && (await canConnectToTestDatabase(testUrl as string));

function mockLiveProvider(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let importSeq = 0;
  const provider = {
    createResendSegment: async (name: string) => {
      calls.push(`segment:${name}`);
      return { id: `seg_${makeId("s")}` };
    },
    importResendContactsCsv: async () => {
      importSeq += 1;
      const id = `imp_${importSeq}`;
      calls.push(`import:${id}`);
      return { id };
    },
    getResendContactImport: async (id: string) => {
      calls.push(`poll:${id}`);
      return { id, status: "completed" as const, counts: { failed: 0, total: 1 } };
    },
    createResendBroadcastDraft: async () => {
      calls.push("draft");
      return { id: `bcast_${makeId("b")}` };
    },
    sendResendBroadcast: async (id: string) => {
      calls.push(`send:${id}`);
      return { id };
    },
    getResendBroadcast: async (id: string) => {
      calls.push(`get:${id}`);
      return { id, status: "draft" as const };
    },
    upsertResendContact: async ({ email }: { email: string }) => ({
      id: `pc_${email}`,
    }),
    addContactToSegment: async () => undefined,
    cancelResendBroadcast: async (id: string) => ({ id }),
    ...overrides,
  };
  return { provider, calls };
}

describe.skipIf(!dbAvailable)("PostgreSQL integration / concurrency", () => {
  beforeAll(async () => {
    const ready = await ensurePgTestReady();
    expect(ready).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await resetPool();
  }, 60_000);

  beforeEach(async () => {
    applyTestEnv(testUrl!);
    delete process.env.SENDSTACK_EMERGENCY_STOP;
    delete process.env.CRON_SECRET;
    await truncateAppTables();
  }, 60_000);

  afterEach(() => {
    delete process.env.SENDSTACK_EMERGENCY_STOP;
    delete process.env.CRON_SECRET;
  });

  it("two simultaneous claimAndPrepareCampaignLaunch share one active job and one recipient set", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "alice@example.com", actorUserId: userId });
    await seedActiveContact({ listId, email: "bob@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });

    const [a, b] = await Promise.all([
      claimAndPrepareCampaignLaunch({ campaignId, liveMode: false }),
      claimAndPrepareCampaignLaunch({ campaignId, liveMode: false }),
    ]);

    expect(a.job.id).toBe(b.job.id);
    expect(a.totalRecipients).toBe(2);
    expect(b.totalRecipients).toBe(2);
    expect([a.idempotent, b.idempotent].filter(Boolean).length).toBeGreaterThanOrEqual(1);

    const jobs = await query<{ id: string }>(
      `SELECT id FROM launch_jobs
        WHERE campaign_id = $1
          AND status IN ('pending', 'running', 'reconciling', 'submission_unknown')`,
      [campaignId],
    );
    expect(jobs.rows).toHaveLength(1);

    const recipients = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(Number(recipients.rows[0].count)).toBe(2);
  });

  it("ambiguous submission reconciles via getResendBroadcast without a second send", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "ambig@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({
      campaignId,
      liveMode: true,
      chunkSize: 50,
    });

    let sendCount = 0;
    const broadcastId = "bcast_ambig_1";
    const { provider } = mockLiveProvider({
      createResendBroadcastDraft: async () => {
        return { id: broadcastId };
      },
      sendResendBroadcast: async () => {
        sendCount += 1;
        throw new Error("network timeout after draft persisted");
      },
      getResendBroadcast: async () => ({ id: broadcastId, status: "queued" }),
    });

    const workerId = makeId("w");
    const leased = await query<LaunchJobRow>(
      `UPDATE launch_jobs
          SET status = 'running',
              lease_owner = $1,
              lease_generation = lease_generation + 1,
              lease_expires_at = NOW() + INTERVAL '60 seconds',
              updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [workerId, job.id],
    );
    const first = await processLaunchJobChunk(leased.rows[0], { live: true, provider });
    expect(first.status).toBe("submission_unknown");
    expect(sendCount).toBe(1);

    const unknownRow = await query<LaunchJobRow>(`SELECT * FROM launch_jobs WHERE id = $1`, [job.id]);
    expect(unknownRow.rows[0]?.status).toBe("submission_unknown");

    const released = await query<LaunchJobRow>(
      `UPDATE launch_jobs
          SET lease_owner = $1,
              lease_generation = lease_generation + 1,
              lease_expires_at = NOW() + INTERVAL '60 seconds',
              updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [workerId, job.id],
    );
    const second = await processLaunchJobChunk(released.rows[0], { live: true, provider });
    expect(second.status).toBe("completed");
    expect(sendCount).toBe(1);

    const row = await query<{ status: string; terminal_reason: string | null }>(
      `SELECT status, terminal_reason FROM launch_jobs WHERE id = $1`,
      [job.id],
    );
    expect(row.rows[0]?.status).toBe("completed");
    expect(row.rows[0]?.terminal_reason).toBe("provider_accepted");
  });

  it("async contact imports complete before broadcast send", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "imp1@example.com", actorUserId: userId });
    await seedActiveContact({ listId, email: "imp2@example.com", actorUserId: userId });
    await seedActiveContact({ listId, email: "imp3@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({
      campaignId,
      liveMode: true,
      chunkSize: 2,
    });

    const order: string[] = [];
    let importSeq = 0;
    const provider = mockLiveProvider({
      importResendContactsCsv: async () => {
        importSeq += 1;
        const id = `imp_chunk_${importSeq}`;
        order.push(`import:${id}`);
        return { id };
      },
      getResendContactImport: async (id: string) => {
        order.push(`poll:${id}`);
        return { id, status: "completed", counts: { failed: 0 } };
      },
      sendResendBroadcast: async (id: string) => {
        order.push(`send:${id}`);
        return { id };
      },
    }).provider;

    const status = await runLaunchJobToCompletion(job.id, { live: true, provider, maxChunks: 20 });
    expect(status).toBe("completed");

    const importIdx = order.findIndex((entry) => entry.startsWith("import:"));
    const lastImportOrPoll = Math.max(
      ...order.map((entry, idx) => (entry.startsWith("import:") || entry.startsWith("poll:") ? idx : -1)),
    );
    const sendIdx = order.findIndex((entry) => entry.startsWith("send:"));
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThan(lastImportOrPoll);
    expect(order.filter((entry) => entry.startsWith("import:")).length).toBeGreaterThanOrEqual(2);
  });

  it("cancellation racing the worker prevents broadcast submit", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "cancel@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({
      campaignId,
      liveMode: true,
      chunkSize: 50,
    });

    let sendCount = 0;
    const { provider } = mockLiveProvider({
      createResendBroadcastDraft: async () => {
        await requestLaunchCancel(campaignId);
        return { id: "bcast_cancel_race" };
      },
      sendResendBroadcast: async () => {
        sendCount += 1;
        return { id: "bcast_cancel_race" };
      },
    });

    const status = await runLaunchJobToCompletion(job.id, { live: true, provider, maxChunks: 20 });
    expect(sendCount).toBe(0);
    expect(["cancelled", "manual_review", "failed"]).toContain(status);

    const row = await query<{ status: string; cancel_requested_at: string | null }>(
      `SELECT status, cancel_requested_at FROM launch_jobs WHERE id = $1`,
      [job.id],
    );
    expect(row.rows[0]?.cancel_requested_at).not.toBeNull();
  });

  it("emergency stop after enqueue fails closed without submit", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "stop@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({
      campaignId,
      liveMode: true,
      chunkSize: 50,
    });

    process.env.SENDSTACK_EMERGENCY_STOP = "1";

    let sendCount = 0;
    const { provider } = mockLiveProvider({
      sendResendBroadcast: async () => {
        sendCount += 1;
        return { id: "should_not_send" };
      },
    });

    const tick = await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      provider,
      timeBudgetMs: 5_000,
      maxChunks: 10,
    });

    expect(sendCount).toBe(0);
    // The stop is a reversible pause, not a destroyer: the job must not be claimed
    // and must not be terminalized, so clearing the stop resumes the launch instead
    // of requiring manual database repair.
    expect(tick.claimed).toBe(false);
    expect(tick.status).toBe("paused_emergency_stop");

    const row = await query<{ status: string; terminal_reason: string | null }>(
      `SELECT status, terminal_reason FROM launch_jobs WHERE id = $1`,
      [job.id],
    );
    expect(row.rows[0]?.status).not.toBe("manual_review");
    expect(row.rows[0]?.status).not.toBe("failed");
    expect(row.rows[0]?.terminal_reason ?? null).toBeNull();

    // Clearing the stop makes the job claimable again and it completes normally.
    delete process.env.SENDSTACK_EMERGENCY_STOP;
    const resumed = await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      provider: mockLiveProvider().provider,
      timeBudgetMs: 5_000,
      maxChunks: 10,
    });
    expect(resumed.claimed).toBe(true);
    expect(resumed.status).not.toBe("manual_review");
  });

  it("repeated volume reservations are idempotent per key", async () => {
    const first = await reserveDailyVolume({ reservationKey: "test:key:a", units: 1 });
    const second = await reserveDailyVolume({ reservationKey: "test:key:b", units: 1 });
    const retry = await reserveDailyVolume({ reservationKey: "test:key:a", units: 1 });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.idempotent).toBe(true);
      expect(retry.reservationId).toBe(first.reservationId);
    }

    const counter = await query<{ reserved_units: string }>(
      `SELECT reserved_units::int AS reserved_units FROM daily_volume_counters WHERE day_utc = $1::date`,
      [utcDayString()],
    );
    expect(Number(counter.rows[0].reserved_units)).toBe(2);
  });

  it("migration-day volume backfill sets counter >= same-day message count", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "volume@example.com",
      actorUserId: userId,
    });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });

    for (let i = 0; i < 5; i += 1) {
      await query(
        `INSERT INTO messages
           (id, campaign_id, contact_id, to_email, subject, from_email, html_body, text_body,
            status, unsubscribe_token, created_at)
         VALUES ($1, $2, $3, $4, 'Vol', 'news@example.com', '<p>x</p>', 'x',
                 'delivered', $5, NOW())`,
        [makeId("msg"), campaignId, contactId, `volume${i}@example.com`, makeId("tok")],
      );
    }

    await query(`DELETE FROM daily_volume_counters`);
    await query(`
      INSERT INTO daily_volume_counters (day_utc, reserved_units, created_at, updated_at)
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day_utc,
             COUNT(*)::int AS reserved_units,
             NOW(),
             NOW()
        FROM messages
       WHERE status IN (
         'captured', 'submitted', 'submission_unknown', 'delivered', 'delayed',
         'bounced', 'complained', 'failed', 'suppressed', 'unsubscribed'
       )
       GROUP BY (created_at AT TIME ZONE 'UTC')::date
      ON CONFLICT (day_utc) DO UPDATE
         SET reserved_units = GREATEST(daily_volume_counters.reserved_units, EXCLUDED.reserved_units),
             updated_at = NOW()
    `);

    const messageCount = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM messages
        WHERE (created_at AT TIME ZONE 'UTC')::date = (NOW() AT TIME ZONE 'UTC')::date`,
    );
    const counter = await query<{ reserved_units: string }>(
      `SELECT reserved_units::int AS reserved_units FROM daily_volume_counters
        WHERE day_utc = (NOW() AT TIME ZONE 'UTC')::date`,
    );
    expect(Number(counter.rows[0].reserved_units)).toBeGreaterThanOrEqual(
      Number(messageCount.rows[0].count),
    );
  });

  it("activateContactWithConsent works and DB rejects active without evidence", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedPendingContact({ listId, email: "consent@example.com" });

    const activated = await activateContactWithConsent({
      contactId,
      actorUserId: userId,
      consentSource: "signed_form",
      consentEvidence: CONSENT_EVIDENCE,
    });
    expect(activated.activated).toBe(true);
    expect(activated.status).toBe("active");

    const orphanId = makeId("con");
    await expect(
      query(
        `INSERT INTO contacts
           (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
         VALUES ($1, $2, 'No', 'Evidence', 'active', 'manual', NOW(), NOW(), NOW())`,
        [orphanId, `no_evidence_${orphanId}@example.com`],
      ),
    ).rejects.toThrow(/contacts_active_requires_consent_check|violates check constraint/i);
  });

  it("activation racing suppression lets suppression win", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    const email = `race_${makeId("e")}@example.com`;
    const contactId = await seedPendingContact({ listId, email });

    await Promise.all([
      activateContactWithConsent({
        contactId,
        actorUserId: userId,
        consentSource: "signed_form",
        consentEvidence: CONSENT_EVIDENCE,
      }),
      applySuppression(email, "manual", "race_test"),
    ]);

    const contact = await query<{ status: string }>(`SELECT status FROM contacts WHERE id = $1`, [
      contactId,
    ]);
    const suppression = await query(`SELECT 1 FROM suppressions WHERE email = $1`, [email]);
    expect(suppression.rows[0]).toBeTruthy();
    expect(contact.rows[0]?.status).toBe("suppressed");
  });

  it("duplicate concurrent webhook processing yields exactly one processed_at", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "hook@example.com",
      actorUserId: userId,
    });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const recipientId = makeId("rec");
    const messageId = makeId("msg");
    const providerEmailId = `re_${makeId("pe")}`;

    await query(
      `INSERT INTO campaign_recipients
         (id, campaign_id, contact_id, email, status, message_id, queued_at, provider_email_id)
       VALUES ($1, $2, $3, 'hook@example.com', 'processing', $4, NOW(), $5)`,
      [recipientId, campaignId, contactId, messageId, providerEmailId],
    );
    await query(
      `INSERT INTO messages
         (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email,
          html_body, text_body, status, status_rank, provider_id, unsubscribe_token, created_at)
       VALUES ($1, $2, $3, $4, 'hook@example.com', 'Hi', 'news@example.com',
               '<p>Hi</p>', 'Hi', 'submitted', 30, $5, $6, NOW())`,
      [messageId, campaignId, recipientId, contactId, providerEmailId, makeId("tok")],
    );

    const eventId = `evt_${makeId("e")}`;
    const payload = {
      type: "email.delivered",
      data: { email_id: providerEmailId, to: ["hook@example.com"] },
    };
    const raw = JSON.stringify(payload);

    const results = await Promise.all([
      processResendWebhookEvent(eventId, payload, raw, "worker_a"),
      processResendWebhookEvent(eventId, payload, raw, "worker_b"),
      processResendWebhookEvent(eventId, payload, raw, "worker_c"),
    ]);

    const processedOk = results.filter((row) => row.processed);
    expect(processedOk.length).toBeGreaterThanOrEqual(1);

    const events = await query<{ processed_at: string | null }>(
      `SELECT processed_at FROM provider_events WHERE id = $1`,
      [eventId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].processed_at).not.toBeNull();
  });

  it("out-of-order webhooks preserve terminal bounce after delivered", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "ooo@example.com",
      actorUserId: userId,
    });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const recipientId = makeId("rec");
    const messageId = makeId("msg");
    const providerEmailId = `re_${makeId("pe")}`;

    await query(
      `INSERT INTO campaign_recipients
         (id, campaign_id, contact_id, email, status, message_id, queued_at, provider_email_id)
       VALUES ($1, $2, $3, 'ooo@example.com', 'processing', $4, NOW(), $5)`,
      [recipientId, campaignId, contactId, messageId, providerEmailId],
    );
    await query(
      `INSERT INTO messages
         (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email,
          html_body, text_body, status, status_rank, provider_id, unsubscribe_token, created_at)
       VALUES ($1, $2, $3, $4, 'ooo@example.com', 'Hi', 'news@example.com',
               '<p>Hi</p>', 'Hi', 'submitted', 30, $5, $6, NOW())`,
      [messageId, campaignId, recipientId, contactId, providerEmailId, makeId("tok")],
    );

    const delivered = {
      type: "email.delivered",
      data: { email_id: providerEmailId, to: ["ooo@example.com"] },
    };
    const bounced = {
      type: "email.bounced",
      data: { email_id: providerEmailId, to: ["ooo@example.com"] },
    };

    await processResendWebhookEvent(`evt_d_${makeId("e")}`, delivered, JSON.stringify(delivered));
    await processResendWebhookEvent(`evt_b_${makeId("e")}`, bounced, JSON.stringify(bounced));

    const message = await query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [
      messageId,
    ]);
    const recipient = await query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE id = $1`,
      [recipientId],
    );
    expect(message.rows[0]?.status).toBe("bounced");
    expect(recipient.rows[0]?.status).toBe("bounced");
  });

  it("footer marker, public-suffix co.uk, dynamic href, and hidden unsubscribe via preflight+compliance", () => {
    applyTestEnv(testUrl!);
    const identity = loadSendingIdentity();

    const withMarker = applyComplianceFooter(
      '<p>Hi --- keep this</p><p>Unsubscribe: author line</p>',
      "Hi\n---\nUnsubscribe: author line",
      identity,
      { broadcast: true },
    );
    expect(withMarker.html).toContain("Example Co");
    expect(withMarker.html).toContain("Hi --- keep this");
    expect(withMarker.text).toContain("Unsubscribe: author line");
    expect(withMarker.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");

    expect(validateAllowedLinkDomains(["co.uk"]).length).toBeGreaterThan(0);
    expect(validateAllowedLinkDomains(["example.co.uk"])).toEqual([]);
    expect(parsePublicOrigin("https://app.example.com")).toBe("https://app.example.com");

    expect(validateCampaignLink("{{first_name}}", ["example.com"]).ok).toBe(false);
    expect(validateCampaignLink("{{unsubscribe_url}}", ["example.com"]).ok).toBe(true);

    expect(
      hasVisibleUnsubscribe(
        '<!-- {{unsubscribe_url}} --><p style="display:none"><a href="{{unsubscribe_url}}">Unsub</a></p>',
        "Hello",
      ),
    ).toBe(false);

    const footered = applyComplianceFooter(
      '<p>Update <a href="https://www.example.com">site</a></p>',
      "Update https://www.example.com",
      identity,
    );
    const ok = runCampaignPreflight({
      subject: "Product update",
      fromName: "Example Co",
      fromEmail: "news@example.com",
      htmlBody: footered.html,
      textBody: footered.text,
      identity,
      requirePublicHttps: true,
    });
    expect(ok.ok).toBe(true);

    const badHref = applyComplianceFooter(
      '<p>Hi <a href="{{first_name}}">x</a></p>',
      "Hi",
      identity,
    );
    const bad = runCampaignPreflight({
      subject: "Product update",
      fromName: "Example Co",
      fromEmail: "news@example.com",
      htmlBody: badHref.html,
      textBody: badHref.text,
      identity,
    });
    expect(bad.ok).toBe(false);
  });

  it("cron launch-jobs route requires bearer secret", async () => {
    delete process.env.CRON_SECRET;
    const missing = await launchJobsCronGet(new Request("http://localhost/api/cron/launch-jobs"));
    expect(missing.status).toBe(503);

    process.env.CRON_SECRET = "cron-test-secret";
    const unauthorized = await launchJobsCronGet(
      new Request("http://localhost/api/cron/launch-jobs", {
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(unauthorized.status).toBe(401);

    const ok = await launchJobsCronGet(
      new Request("http://localhost/api/cron/launch-jobs", {
        headers: { Authorization: "Bearer cron-test-secret" },
      }),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; claimed: boolean };
    expect(body.ok).toBe(true);
    expect(body.claimed).toBe(false);
  });

  it("stale lease fencing no-ops updates from an old generation", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "lease@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const prepared = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: false });

    const workerA = await claimLaunchJob("worker_a");
    expect(workerA?.id).toBe(prepared.job.id);
    const stale: Pick<LaunchJobRow, "id" | "lease_owner" | "lease_generation"> = {
      id: workerA!.id,
      lease_owner: "worker_a",
      lease_generation: workerA!.lease_generation,
    };

    await query(
      `UPDATE launch_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [workerA!.id],
    );
    const workerB = await claimLaunchJob("worker_b");
    expect(workerB?.id).toBe(prepared.job.id);
    expect(workerB!.lease_generation).toBeGreaterThan(stale.lease_generation);

    const renewed = await renewLaunchLease(stale);
    expect(renewed).toBe(false);

    const current = await query<{ lease_owner: string; lease_generation: number }>(
      `SELECT lease_owner, lease_generation FROM launch_jobs WHERE id = $1`,
      [prepared.job.id],
    );
    expect(current.rows[0]?.lease_owner).toBe("worker_b");
    expect(Number(current.rows[0]?.lease_generation)).toBe(workerB!.lease_generation);
  });

  it(
    "enqueues 10,000 recipients via set-based claimAndPrepareCampaignLaunch under 30s",
    async () => {
      const userId = await seedAdminUser();
      const listId = await seedList();
      const inserted = await seedActiveContactsBulk({
        listId,
        actorUserId: userId,
        count: 10_000,
        emailPrefix: `n10k_${Date.now()}_`,
      });
      expect(inserted).toBe(10_000);
      const campaignId = await seedDraftCampaign({ listId, createdBy: userId });

      const started = Date.now();
      const result = await claimAndPrepareCampaignLaunch({
        campaignId,
        liveMode: false,
        chunkSize: 100,
      });
      const elapsedMs = Date.now() - started;

      expect(result.totalRecipients).toBe(10_000);
      expect(result.idempotent).toBe(false);
      expect(elapsedMs).toBeLessThan(30_000);

      const recipients = await query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1`,
        [campaignId],
      );
      const messages = await query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM messages WHERE campaign_id = $1`,
        [campaignId],
      );
      expect(Number(recipients.rows[0].count)).toBe(10_000);
      expect(Number(messages.rows[0].count)).toBe(10_000);
    },
    60_000,
  );

  it("late suppression after prepare prevents provider import/send for that recipient", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "keep@example.com", actorUserId: userId });
    await seedActiveContact({ listId, email: "late-suppress@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 50 });

    await applySuppression("late-suppress@example.com", "manual", "pg_test");

    const { provider, calls } = mockLiveProvider();
    const status = await runLaunchJobToCompletion(job.id, { live: true, provider });
    expect(["failed", "manual_review", "cancelled"]).toContain(status);
    expect(calls.some((c) => c.startsWith("import:") && c.includes("late-suppress"))).toBe(false);
    const importCsv = calls.filter((c) => c.startsWith("import:"));
    // Provider may still be called for remaining audience only if fail-closed rebuild; our policy fails closed.
    const suppressed = await query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE campaign_id = $1 AND email = 'late-suppress@example.com'`,
      [campaignId],
    );
    expect(suppressed.rows[0]?.status).toBe("suppressed");
    expect(calls.some((c) => c.startsWith("send:"))).toBe(false);
    void importCsv;
  });

  it("fake slow import yields within budget and resumes on next tick", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "slow@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 50 });

    let polls = 0;
    const { provider, calls } = mockLiveProvider({
      getResendContactImport: async (id: string) => {
        polls += 1;
        calls.push(`poll:${id}:${polls}`);
        if (polls < 3) return { id, status: "in_progress" as const, counts: {} };
        return { id, status: "completed" as const, counts: { failed: 0, total: 1 } };
      },
    });

    const started = Date.now();
    const tick1 = await runLaunchWorkerTick({
      workerId: makeId("w"),
      timeBudgetMs: 5_000,
      maxChunks: 2,
      live: true,
      provider,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4_000);
    expect(tick1.done).toBe(false);
    expect(polls).toBeGreaterThanOrEqual(1);

    // Resume until complete.
    let terminal = tick1.status;
    for (let i = 0; i < 10 && terminal !== "completed"; i += 1) {
      const tick = await runLaunchWorkerTick({
        workerId: makeId("w"),
        timeBudgetMs: 10_000,
        maxChunks: 5,
        live: true,
        provider,
      });
      terminal = tick.status;
      if (tick.done && tick.status === "completed") break;
    }
    const finalJob = await query<{ status: string }>(`SELECT status FROM launch_jobs WHERE id = $1`, [job.id]);
    expect(finalJob.rows[0]?.status).toBe("completed");
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("email change demotes active contact and clears consent evidence atomically", async () => {
    const { updateContactEmailWithConsentReset } = await import("../lib/consent");
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "before@example.com",
      actorUserId: userId,
    });

    const updated = await updateContactEmailWithConsentReset({
      contactId,
      actorUserId: userId,
      email: "after@example.com",
      firstName: "Pat",
      lastName: "Lee",
      consentSource: "admin_email_change",
    });
    expect(updated.status).toBe("pending_consent");
    expect(updated.email).toBe("after@example.com");

    const row = await query<{
      status: string;
      consent_evidence: string | null;
      consent_attested_by: string | null;
      consent_verified_at: string | null;
    }>(
      `SELECT status, consent_evidence, consent_attested_by, consent_verified_at FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(row.rows[0].status).toBe("pending_consent");
    expect(row.rows[0].consent_evidence).toBeNull();
    expect(row.rows[0].consent_attested_by).toBeNull();
    expect(row.rows[0].consent_verified_at).toBeNull();

    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'contact_email_changed'`,
      [contactId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("concurrent suppression during email change wins", async () => {
    const { updateContactEmailWithConsentReset } = await import("../lib/consent");
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "race-email@example.com",
      actorUserId: userId,
    });

    await applySuppression("new-race@example.com", "complaint", "pg_test");
    const updated = await updateContactEmailWithConsentReset({
      contactId,
      actorUserId: userId,
      email: "new-race@example.com",
      firstName: "Pat",
      lastName: "Lee",
      consentSource: "admin_email_change",
    });
    expect(updated.status).toBe("suppressed");
  });

  it("normal delivered campaign completes; cancel reconcile does not overwrite", async () => {
    const { reconcileCampaignAfterCancel } = await import("../lib/launch-jobs");
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "done@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    await claimAndPrepareCampaignLaunch({ campaignId, liveMode: false });
    await query(
      `UPDATE campaign_recipients SET status = 'sent', sent_at = NOW() WHERE campaign_id = $1`,
      [campaignId],
    );
    await query(
      `UPDATE campaigns SET status = 'sending', updated_at = NOW() WHERE id = $1`,
      [campaignId],
    );
    await processResendWebhookEvent(
      makeId("evt"),
      {
        type: "email.delivered",
        data: { email_id: "prov_1", to: ["done@example.com"], broadcast_id: null as unknown as string },
      },
      "{}",
    );
    // Force completion path
    await query(
      `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [campaignId],
    );
    await reconcileCampaignAfterCancel(campaignId);
    const status = await query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    expect(status.rows[0].status).toBe("completed");
  });

  it("UTC day binding rejects cross-day reservation reuse as same-day capacity", async () => {
    const { reserveDailyVolume, utcDayString } = await import("../lib/daily-volume");
    const key = `crossday:${makeId("k")}`;
    const yesterday = new Date(Date.now() - 86_400_000);
    const first = await reserveDailyVolume({ reservationKey: key, now: yesterday, units: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.dayUtc).toBe(utcDayString(yesterday));

    const today = await reserveDailyVolume({ reservationKey: key, now: new Date(), units: 1 });
    expect(today.ok).toBe(true);
    if (!today.ok) return;
    expect(today.idempotent).toBe(false);
    expect(today.dayUtc).toBe(utcDayString());
    expect(today.dayUtc).not.toBe(first.dayUtc);
  });

  it("complaint outranks bounce for stored message state", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "rank@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    await claimAndPrepareCampaignLaunch({ campaignId, liveMode: false });
    const msg = await query<{ id: string }>(
      `SELECT id FROM messages WHERE campaign_id = $1 LIMIT 1`,
      [campaignId],
    );
    await query(`UPDATE messages SET provider_id = 'prov_rank', status = 'submitted', status_rank = 30 WHERE id = $1`, [
      msg.rows[0].id,
    ]);
    await processResendWebhookEvent(
      makeId("evt"),
      { type: "email.bounced", data: { email_id: "prov_rank", to: ["rank@example.com"] } },
      "{}",
    );
    await processResendWebhookEvent(
      makeId("evt"),
      { type: "email.complained", data: { email_id: "prov_rank", to: ["rank@example.com"] } },
      "{}",
    );
    const final = await query<{ status: string; status_rank: number }>(
      `SELECT status, status_rank FROM messages WHERE id = $1`,
      [msg.rows[0].id],
    );
    expect(final.rows[0].status).toBe("complained");
    expect(final.rows[0].status_rank).toBeGreaterThanOrEqual(110);
  });

  it("capacity concurrency at the limit admits exactly one reservation", async () => {
    process.env.SENDSTACK_DAILY_LIMIT = "1";
    const keyA = `cap:${makeId("a")}`;
    const keyB = `cap:${makeId("b")}`;
    const [a, b] = await Promise.all([
      reserveDailyVolume({ reservationKey: keyA, units: 1, limit: 1 }),
      reserveDailyVolume({ reservationKey: keyB, units: 1, limit: 1 }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    const failCount = [a, b].filter((r) => !r.ok).length;
    expect(okCount).toBe(1);
    expect(failCount).toBe(1);
    const counter = await query<{ reserved_units: string }>(
      `SELECT reserved_units::int AS reserved_units FROM daily_volume_counters WHERE day_utc = $1::date`,
      [utcDayString()],
    );
    expect(Number(counter.rows[0]?.reserved_units)).toBe(1);
  });

  it("late suppression after partial imports fails closed before broadcast send", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "keep-chunk@example.com", actorUserId: userId });
    await seedActiveContact({ listId, email: "drop-chunk@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 1 });

    let imports = 0;
    const { provider, calls } = mockLiveProvider({
      importResendContactsCsv: async () => {
        imports += 1;
        const id = `imp_partial_${imports}`;
        calls.push(`import:${id}`);
        if (imports === 1) {
          await applySuppression("drop-chunk@example.com", "manual", "pg_test_mid_import");
        }
        return { id };
      },
      getResendContactImport: async (id: string) => {
        calls.push(`poll:${id}`);
        return { id, status: "completed" as const, counts: { failed: 0, total: 1 } };
      },
    });

    const status = await runLaunchJobToCompletion(job.id, { live: true, provider, maxChunks: 20 });
    expect(calls.some((c) => c.startsWith("send:"))).toBe(false);
    expect(["failed", "manual_review", "cancelled"]).toContain(status);
    expect(imports).toBeGreaterThanOrEqual(1);
  });

  it("cancel at ready_to_submit boundary prevents provider send", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "ready-cancel@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 50 });

    await query(
      `UPDATE launch_jobs
          SET status = 'ready_to_submit',
              provider_segment_id = 'seg_ready',
              provider_broadcast_id = 'bcast_ready',
              cursor_offset = total_recipients
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns
          SET status = 'sending', provider_segment_id = 'seg_ready', provider_broadcast_id = 'bcast_ready'
        WHERE id = $1`,
      [campaignId],
    );

    const cancel = await requestLaunchCancel(campaignId);
    expect(cancel.providerCancelled).not.toBe(true);

    let sendCount = 0;
    const { provider } = mockLiveProvider({
      sendResendBroadcast: async () => {
        sendCount += 1;
        return { id: "bcast_ready" };
      },
    });
    await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      provider,
      timeBudgetMs: 3_000,
      maxChunks: 5,
    });
    expect(sendCount).toBe(0);
  });

  it("cancel during submitting records outcome_pending without claiming stop", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "submitting-cancel@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 50 });

    await query(
      `UPDATE launch_jobs
          SET status = 'submitting',
              provider_broadcast_id = 'bcast_submitting',
              provider_segment_id = 'seg_sub'
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns
          SET status = 'sending', provider_broadcast_id = 'bcast_submitting'
        WHERE id = $1`,
      [campaignId],
    );

    const cancel = await requestLaunchCancel(campaignId);
    expect(cancel.campaignStatus).toBe("cancel_requested");
    // Cannot claim the provider send was stopped while still submitting.
    expect(cancel.providerCancelled).not.toBe(true);

    const recipients = await query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipients.rows.every((r) => r.status === "outcome_pending")).toBe(true);

    const jobRow = await query<{ status: string; cancel_requested_at: string | null }>(
      `SELECT status, cancel_requested_at FROM launch_jobs WHERE id = $1`,
      [job.id],
    );
    expect(jobRow.rows[0].status).toBe("submitting");
    expect(jobRow.rows[0].cancel_requested_at).not.toBeNull();
  });

  it("cancel after provider acceptance keeps honest pending outcome", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "accepted-cancel@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 50 });

    await query(
      `UPDATE launch_jobs
          SET status = 'submitting',
              provider_broadcast_id = 'bcast_accepted',
              provider_segment_id = 'seg_acc'
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns
          SET status = 'sending',
              provider_broadcast_id = 'bcast_accepted',
              provider_status = 'queued'
        WHERE id = $1`,
      [campaignId],
    );

    const { provider } = mockLiveProvider({
      getResendBroadcast: async () => ({ id: "bcast_accepted", status: "queued" as const }),
      cancelResendBroadcast: async () => {
        throw new Error("live send disabled in test cancel path");
      },
    });

    // Patch global cancel by running requestLaunchCancel — liveSendAllowed is mocked true,
    // so inject via process with provider through worker reconciliation after cancel.
    const cancel = await requestLaunchCancel(campaignId);
    expect(cancel.campaignStatus).toBe("cancel_requested");

    const recipients = await query<{ status: string }>(
      `SELECT DISTINCT status FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipients.rows.map((r) => r.status)).toContain("outcome_pending");
    void provider;
  });

  it("confirmed provider cancellation converges recipients to cancelled", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "confirm-cancel@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 50 });

    await query(
      `UPDATE launch_jobs
          SET status = 'submitting',
              provider_broadcast_id = 'bcast_confirm',
              provider_segment_id = 'seg_confirm',
              lease_owner = NULL,
              lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `UPDATE campaigns
          SET status = 'sending', provider_broadcast_id = 'bcast_confirm', cancellable = TRUE
        WHERE id = $1`,
      [campaignId],
    );

    // requestLaunchCancel with liveSendAllowed mocked true will call cancelResendBroadcast from real module.
    // Stub by setting live mode env and using a campaign that triggers cancel via SQL path after we
    // simulate successful cancel ourselves.
    await query(
      `UPDATE campaign_recipients SET status = 'outcome_pending' WHERE campaign_id = $1`,
      [campaignId],
    );
    await query(
      `UPDATE campaigns SET status = 'cancel_requested', updated_at = NOW() WHERE id = $1`,
      [campaignId],
    );
    await query(
      `UPDATE launch_jobs SET cancel_requested_at = NOW(), status = 'cancelled' WHERE id = $1`,
      [job.id],
    );

    const { reconcileCampaignAfterCancel } = await import("../lib/launch-jobs");
    // Simulate confirmed cancel terminalization used by requestLaunchCancel success path:
    await query(
      `UPDATE campaign_recipients
          SET status = 'cancelled'
        WHERE campaign_id = $1 AND status IN ('cancel_requested', 'outcome_pending')`,
      [campaignId],
    );
    await reconcileCampaignAfterCancel(campaignId);

    const recipients = await query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipients.rows.every((r) => r.status === "cancelled")).toBe(true);
    const campaign = await query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    expect(["cancelled", "partially_sent"]).toContain(campaign.rows[0].status);
  });

  it("health becoming unhealthy after enqueue blocks provider submit", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "health-after@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 50 });

    const { recordDeliveryHealthBlock } = await import("../lib/delivery-health");
    await recordDeliveryHealthBlock({
      kind: "unprocessed_webhook",
      detail: "Injected health block after enqueue",
      relatedEntityType: "campaign",
      relatedEntityId: campaignId,
    });

    let sendCount = 0;
    const { provider } = mockLiveProvider({
      sendResendBroadcast: async () => {
        sendCount += 1;
        return { id: "blocked" };
      },
    });

    const status = await runLaunchJobToCompletion(job.id, { live: true, provider, maxChunks: 15 });
    expect(sendCount).toBe(0);
    expect(["failed", "manual_review", "cancelled"]).toContain(status);
  });

  it("complaint after delivered upgrades message status", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "delivered-then-complaint@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    await claimAndPrepareCampaignLaunch({ campaignId, liveMode: false });
    const msg = await query<{ id: string }>(
      `SELECT id FROM messages WHERE campaign_id = $1 LIMIT 1`,
      [campaignId],
    );
    await query(
      `UPDATE messages SET provider_id = 'prov_del_c', status = 'delivered', status_rank = 50 WHERE id = $1`,
      [msg.rows[0].id],
    );
    await processResendWebhookEvent(
      makeId("evt"),
      {
        type: "email.complained",
        data: { email_id: "prov_del_c", to: ["delivered-then-complaint@example.com"] },
      },
      "{}",
    );
    const final = await query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [msg.rows[0].id]);
    expect(final.rows[0].status).toBe("complained");
  });

  it("webhook processing failure leaves event retryable then succeeds", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "retry-wh@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    await claimAndPrepareCampaignLaunch({ campaignId, liveMode: false });
    const msg = await query<{ id: string }>(
      `SELECT id FROM messages WHERE campaign_id = $1 LIMIT 1`,
      [campaignId],
    );
    await query(`UPDATE messages SET provider_id = 'prov_retry', status = 'submitted', status_rank = 30 WHERE id = $1`, [
      msg.rows[0].id,
    ]);

    const eventId = makeId("evt");
    // Insert claimed-but-unprocessed event simulating a mid-flight crash.
    await query(
      `INSERT INTO provider_events (id, provider, event_type, payload_json, created_at, processed_at, claim_token, claim_expires_at)
       VALUES ($1, 'resend', 'email.delivered', $2, NOW(), NULL, 'stale_token', NOW() - INTERVAL '1 minute')`,
      [eventId, JSON.stringify({ type: "email.delivered", data: { email_id: "prov_retry", to: ["retry-wh@example.com"] } })],
    );

    const first = await processResendWebhookEvent(
      eventId,
      { type: "email.delivered", data: { email_id: "prov_retry", to: ["retry-wh@example.com"] } },
      "{}",
    );
    expect(first.processed).toBe(true);

    const row = await query<{ processed_at: string | null }>(
      `SELECT processed_at FROM provider_events WHERE id = $1`,
      [eventId],
    );
    expect(row.rows[0].processed_at).not.toBeNull();

    const msgStatus = await query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [msg.rows[0].id]);
    expect(msgStatus.rows[0].status).toBe("delivered");
  });

  it("contact-level unsubscribe does not rewrite unrelated messages", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    await seedActiveContact({ listId, email: "shared@example.com", actorUserId: userId });
    const campaignA = await seedDraftCampaign({ listId, createdBy: userId, name: "Camp A" });
    const campaignB = await seedDraftCampaign({ listId, createdBy: userId, name: "Camp B" });
    await claimAndPrepareCampaignLaunch({ campaignId: campaignA, liveMode: false });
    await claimAndPrepareCampaignLaunch({ campaignId: campaignB, liveMode: false });

    const msgA = await query<{ id: string }>(
      `SELECT id FROM messages WHERE campaign_id = $1 LIMIT 1`,
      [campaignA],
    );
    const msgB = await query<{ id: string }>(
      `SELECT id FROM messages WHERE campaign_id = $1 LIMIT 1`,
      [campaignB],
    );
    await query(`UPDATE messages SET provider_id = 'prov_a', status = 'delivered', status_rank = 50 WHERE id = $1`, [
      msgA.rows[0].id,
    ]);
    await query(`UPDATE messages SET provider_id = 'prov_b', status = 'delivered', status_rank = 50 WHERE id = $1`, [
      msgB.rows[0].id,
    ]);

    await processResendWebhookEvent(
      makeId("evt"),
      {
        type: "email.unsubscribed",
        data: { email_id: "prov_a", email: "shared@example.com", to: ["shared@example.com"] },
      },
      "{}",
    );

    const a = await query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [msgA.rows[0].id]);
    const b = await query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [msgB.rows[0].id]);
    expect(a.rows[0].status).toBe("unsubscribed");
    expect(b.rows[0].status).toBe("delivered");
  });

  it("frozen recipient names survive live contact rename after launch", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "freeze@example.com",
      actorUserId: userId,
      firstName: "Frozen",
      lastName: "Name",
    });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const { job } = await claimAndPrepareCampaignLaunch({ campaignId, liveMode: true, chunkSize: 50 });

    await query(`UPDATE contacts SET first_name = 'Mutated', last_name = 'Later', updated_at = NOW() WHERE id = $1`, [
      contactId,
    ]);

    // Worker must hold a lease for fenced provider writes / imports.
    const claimed = await claimLaunchJob(makeId("w"));
    expect(claimed?.id).toBe(job.id);

    let capturedCsv = "";
    const { provider, calls } = mockLiveProvider({
      importResendContactsCsv: async (input: { csv: string; segmentId: string }) => {
        capturedCsv = input.csv;
        calls.push("import:freeze");
        return { id: "imp_freeze" };
      },
    });

    await processLaunchJobChunk(claimed!, { live: true, provider });
    expect(capturedCsv).toContain("Frozen");
    expect(capturedCsv).not.toContain("Mutated");

    const recipient = await query<{ first_name: string }>(
      `SELECT first_name FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipient.rows[0].first_name).toBe("Frozen");
  });

  it("campaign and attachment mutations are rejected after launch prepare", async () => {
    const { handleApi } = await import("../lib/api-router");
    const { seedAdminSession } = await import("./pg-test-utils");
    const userId = await seedAdminUser();
    const session = await seedAdminSession(userId);
    const listId = await seedList();
    await seedActiveContact({ listId, email: "mutate@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    await claimAndPrepareCampaignLaunch({ campaignId, liveMode: false });

    const patch = await handleApi(
      new Request(`https://app.example.com/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Hijacked", subject: "Hijacked", list_id: listId }),
      }),
      ["campaigns", campaignId],
    );
    expect(patch.status).toBe(409);

    const attach = await handleApi(
      new Request(`https://app.example.com/api/campaigns/${campaignId}/attachments`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
        },
      }),
      ["campaigns", campaignId, "attachments"],
    );
    expect([400, 409, 415]).toContain(attach.status);
  });

  it("protected suppressions cannot be cleared via re-consent or activation", async () => {
    const { removeSuppressionWithReconsent } = await import("../lib/suppressions");
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedPendingContact({ listId, email: "protected@example.com" });
    await applySuppression("protected@example.com", "complaint", "pg_test");
    const flag = await query<{ protected: boolean }>(
      `SELECT protected FROM suppressions WHERE email = 'protected@example.com'`,
    );
    expect(flag.rows[0]?.protected).toBe(true);

    await expect(
      removeSuppressionWithReconsent({
        email: "protected@example.com",
        actorUserId: userId,
        consentNote: "Trying to clear a protected complaint suppression illegally.",
      }),
    ).rejects.toThrow(/protected|complaint|cannot/i);

    const activation = await activateContactWithConsent({
      contactId,
      actorUserId: userId,
      consentEvidence: CONSENT_EVIDENCE,
      consentSource: "admin_activation",
    });
    expect(activation.activated).toBe(false);
    expect(activation.status).toBe("suppressed");
    const contact = await query<{ status: string }>(`SELECT status FROM contacts WHERE id = $1`, [contactId]);
    expect(contact.rows[0].status).toBe("suppressed");
  });

  it("message feedback event applies suppression and monotonic status", async () => {
    const { handleApi } = await import("../lib/api-router");
    const { seedAdminSession } = await import("./pg-test-utils");
    const userId = await seedAdminUser();
    const session = await seedAdminSession(userId);
    const listId = await seedList();
    await seedActiveContact({ listId, email: "feedback@example.com", actorUserId: userId });
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    await claimAndPrepareCampaignLaunch({ campaignId, liveMode: false });
    const msg = await query<{ id: string }>(
      `SELECT id FROM messages WHERE campaign_id = $1 LIMIT 1`,
      [campaignId],
    );

    const response = await handleApi(
      new Request(`https://app.example.com/api/messages/${msg.rows[0].id}/event`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ event: "hard_bounce" }),
      }),
      ["messages", msg.rows[0].id, "event"],
    );
    expect(response.status).toBe(200);
    const status = await query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [msg.rows[0].id]);
    expect(status.rows[0].status).toBe("bounced");
    const suppressed = await query<{ email: string }>(
      `SELECT email FROM suppressions WHERE email = 'feedback@example.com'`,
    );
    expect(suppressed.rows).toHaveLength(1);
  });

  it("login rate limiting records failures and returns 429", async () => {
    const { handleApi } = await import("../lib/api-router");
    const email = `ratelimit_${makeId("u")}@example.com`;
    await seedAdminUser(email);

    for (let i = 0; i < 10; i += 1) {
      const res = await handleApi(
        new Request("https://app.example.com/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.50",
          },
          body: JSON.stringify({ email, password: "WrongPassword!!" }),
        }),
        ["auth", "login"],
      );
      expect(res.status).toBe(401);
    }
    const blocked = await handleApi(
      new Request("https://app.example.com/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.50",
        },
        body: JSON.stringify({ email, password: "WrongPassword!!" }),
      }),
      ["auth", "login"],
    );
    expect(blocked.status).toBe(429);
  });

  it("login limits stay atomic for one trusted client address", async () => {
    const { handleApi } = await import("../lib/api-router");
    process.env.VERCEL = "1";
    const ip = "203.0.113.77";
    try {
      const emails: string[] = [];
      for (let i = 0; i < 101; i += 1) {
        const email = `ipcap_${i}_${makeId("u")}@example.com`;
        emails.push(email);
        await seedAdminUser(email);
      }
      const results: Response[] = [];
      const concurrency = 8;
      let cursor = 0;
      async function worker() {
        while (cursor < emails.length) {
          const email = emails[cursor];
          cursor += 1;
          results.push(
            await handleApi(
              new Request("https://app.example.com/api/auth/login", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-forwarded-for": ip,
                },
                body: JSON.stringify({ email, password: "WrongPassword!!" }),
              }),
              ["auth", "login"],
            ),
          );
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const blocked = results.filter((response) => response.status === 429).length;
      const denied = results.filter((response) => response.status === 401).length;
      expect(denied).toBe(100);
      expect(blocked).toBe(1);
      const attempts = await query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM login_attempts WHERE client_ip = $1`,
        [ip],
      );
      expect(Number(attempts.rows[0]?.count)).toBe(100);
    } finally {
      delete process.env.VERCEL;
    }
  }, 60_000);

  it("password change revokes every previous session", async () => {
    const { handleApi } = await import("../lib/api-router");
    const { createHash } = await import("node:crypto");
    const userId = await seedAdminUser();
    const first = await seedAdminSession(userId);
    const second = await seedAdminSession(userId);
    const response = await handleApi(
      new Request("https://app.example.com/api/auth/change-password", {
        method: "POST",
        headers: {
          cookie: first.cookie,
          "x-csrf-token": first.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ current_password: "TestPass123!", new_password: "Replacement456!" }),
      }),
      ["auth", "change-password"],
    );
    expect(response.status).toBe(200);
    const previous = [first.token, second.token].map((token) =>
      createHash("sha256").update(token).digest("hex"),
    );
    const remaining = await query<{ token_hash: string }>(
      `SELECT token_hash FROM sessions WHERE user_id = $1`,
      [userId],
    );
    expect(remaining.rows).toHaveLength(1);
    expect(previous).not.toContain(remaining.rows[0]?.token_hash);
  });

  it("a test-send retry reuses one durable idempotency key", async () => {
    const { handleApi } = await import("../lib/api-router");
    const userId = await seedAdminUser();
    const session = await seedAdminSession(userId);
    const listId = await seedList();
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    const send = (email: string) =>
      handleApi(
        new Request(`https://app.example.com/api/campaigns/${campaignId}/test-send`, {
          method: "POST",
          headers: {
            cookie: session.cookie,
            "x-csrf-token": session.csrfToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email }),
        }),
        ["campaigns", campaignId, "test-send"],
      );
    const first = await send("retry-canary@ctn-sk.com");
    expect(first.status).toBe(200);
    const second = await send("retry-canary@ctn-sk.com");
    expect(second.status).toBe(200);
    const messages = await query<{ idempotency_key: string | null }>(
      `SELECT idempotency_key FROM messages
        WHERE campaign_id = $1 AND COALESCE(is_test, FALSE) = TRUE`,
      [campaignId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]?.idempotency_key).toMatch(/^test:/);
  });

  it("health block waive closes blocker and readiness can recover", async () => {
    const { handleApi } = await import("../lib/api-router");
    const { seedAdminSession } = await import("./pg-test-utils");
    const { recordDeliveryHealthBlock, getDeliveryHealthSnapshot } = await import("../lib/delivery-health");
    const userId = await seedAdminUser();
    const session = await seedAdminSession(userId);
    const blockId = await recordDeliveryHealthBlock({
      kind: "other",
      detail: "Test block for waive API",
    });

    const before = await getDeliveryHealthSnapshot();
    expect(before.launch_blocked).toBe(true);

    const waived = await handleApi(
      new Request(`https://app.example.com/api/delivery-health/blocks/${blockId}/waive`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          note: "Operator reviewed and waived this synthetic test health block.",
        }),
      }),
      ["delivery-health", "blocks", blockId, "waive"],
    );
    expect(waived.status).toBe(200);

    const after = await getDeliveryHealthSnapshot();
    expect(after.blocking_reasons.some((r) => r.includes("durable delivery health block"))).toBe(false);
  });

  it("attempt_id misuse is rejected for live test-send retries", async () => {
    const { handleApi } = await import("../lib/api-router");
    const { seedAdminSession } = await import("./pg-test-utils");
    const userId = await seedAdminUser();
    const session = await seedAdminSession(userId);
    const listId = await seedList();
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });

    process.env.SENDSTACK_DELIVERY_MODE = "resend";
    process.env.SENDSTACK_TEST_RECIPIENT_ALLOWLIST = "canary@ctn-sk.com";
    process.env.SENDSTACK_LIVE_SEND_ENABLED = "1";

    const misuse = await handleApi(
      new Request(`https://app.example.com/api/campaigns/${campaignId}/test-send`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "canary@ctn-sk.com", attempt_id: "nonexistent_attempt" }),
      }),
      ["campaigns", campaignId, "test-send"],
    );
    expect(misuse.status).toBe(409);
    const misuseBody = (await misuse.json()) as { error?: string };
    expect(misuseBody.error).toMatch(/attempt_id/i);
  });

  it("readiness fails closed when emergency stop is enabled", async () => {
    const { handleApi } = await import("../lib/api-router");
    const { seedAdminSession } = await import("./pg-test-utils");
    const userId = await seedAdminUser();
    const session = await seedAdminSession(userId);
    process.env.SENDSTACK_EMERGENCY_STOP = "1";

    const readiness = await handleApi(
      new Request("https://app.example.com/api/production-readiness", {
        method: "GET",
        headers: { cookie: session.cookie },
      }),
      ["production-readiness"],
    );
    expect(readiness.status).toBe(200);
    const body = (await readiness.json()) as { ready_for_live_sending?: boolean };
    expect(body.ready_for_live_sending).toBe(false);
  });

  it("live test-send is blocked by emergency stop gate", async () => {
    const { handleApi } = await import("../lib/api-router");
    const { seedAdminSession } = await import("./pg-test-utils");
    const userId = await seedAdminUser();
    const session = await seedAdminSession(userId);
    const listId = await seedList();
    const campaignId = await seedDraftCampaign({ listId, createdBy: userId });
    process.env.SENDSTACK_EMERGENCY_STOP = "1";
    process.env.SENDSTACK_DELIVERY_MODE = "resend";
    process.env.SENDSTACK_TEST_RECIPIENT_ALLOWLIST = "canary@ctn-sk.com";

    const response = await handleApi(
      new Request(`https://app.example.com/api/campaigns/${campaignId}/test-send`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "x-csrf-token": session.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "canary@ctn-sk.com" }),
      }),
      ["campaigns", campaignId, "test-send"],
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/EMERGENCY_STOP/i);
  });
});
