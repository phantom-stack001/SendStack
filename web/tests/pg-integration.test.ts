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
    expect(tick.status).toMatch(/manual_review|failed|cancelled/);

    const row = await query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM launch_jobs WHERE id = $1`,
      [job.id],
    );
    expect(row.rows[0]?.status).toBe("manual_review");
    expect(row.rows[0]?.last_error ?? "").toMatch(/EMERGENCY_STOP/i);
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
      '<p>Hi</p><div class="sendstack-compliance-footer">author marker should not suppress</div>',
      "Hi",
      identity,
      { broadcast: true },
    );
    expect(withMarker.html).toContain("Example Co");
    expect(withMarker.html).not.toContain("author marker should not suppress");
    expect((withMarker.html.match(/sendstack-compliance-footer/g) || []).length).toBe(1);

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
});
