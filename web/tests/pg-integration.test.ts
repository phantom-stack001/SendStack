import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/live-send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/live-send")>();
  return {
    ...actual,
    // Vitest sets NODE_ENV=test; production liveSendAllowed hard-fails there.
    liveSendAllowed: () => true,
  };
});

import { GET as launchJobsCronGet } from "../app/api/cron/launch-jobs/route";
import { createContact, importContactStatus, updateContact } from "../lib/consent";
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
import { loadSendingIdentity } from "../lib/sending-identity";
import { applySuppression } from "../lib/suppressions";
import { makeId } from "../lib/ids";
import {
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
  truncateAppTables,
} from "./pg-test-utils";

const testUrl = resolveTestDatabaseUrl();
const dbAvailable = Boolean(testUrl) && (await canConnectToTestDatabase(testUrl as string));

function mockLiveSmtp(overrides: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const sendEmail = async (input: { to: string }) => {
    calls.push(`send:${input.to}`);
    if (overrides.fail) throw new Error("SMTP 550 rejected");
    return { id: `smtp_${makeId("m")}`, accepted: true };
  };
  return { sendEmail: sendEmail as never, calls };
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

    const tokens = await query<{ unsubscribe_token: string | null }>(
      `SELECT unsubscribe_token FROM messages WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(tokens.rows.length).toBe(2);
    expect(tokens.rows.every((row) => row.unsubscribe_token === null)).toBe(true);
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

    const { sendEmail, calls } = mockLiveSmtp();

    const tick = await runLaunchWorkerTick({
      workerId: makeId("w"),
      live: true,
      sendEmail,
      timeBudgetMs: 5_000,
      maxChunks: 10,
    });

    expect(calls).toHaveLength(0);
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
      sendEmail: mockLiveSmtp().sendEmail,
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

  it("createContact is active without consent evidence and import status matches", async () => {
    const listId = await seedList();
    expect(importContactStatus(false)).toBe("active");
    expect(importContactStatus(true)).toBe("suppressed");

    const created = await createContact({
      email: "consent@example.com",
      listId,
    });
    expect(created.status).toBe("active");
    const named = await query<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM contacts WHERE id = $1`,
      [created.id],
    );
    expect(named.rows[0]?.first_name).toBe("");
    expect(named.rows[0]?.last_name).toBe("");

    const orphanId = makeId("con");
    await query(
      `INSERT INTO contacts
         (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
       VALUES ($1, $2, 'No', 'Evidence', 'active', 'manual', NOW(), NOW(), NOW())`,
      [orphanId, `no_evidence_${orphanId}@example.com`],
    );
    const row = await query<{ status: string }>(`SELECT status FROM contacts WHERE id = $1`, [
      orphanId,
    ]);
    expect(row.rows[0]?.status).toBe("active");
  });

  it("createContact against a suppressed address stays suppressed", async () => {
    const listId = await seedList();
    const email = `race_${makeId("e")}@example.com`;
    await applySuppression(email, "manual", "race_test");

    const created = await createContact({
      email,
      listId,
    });
    expect(created.status).toBe("suppressed");
    const contact = await query<{ status: string }>(`SELECT status FROM contacts WHERE id = $1`, [
      created.id,
    ]);
    expect(contact.rows[0]?.status).toBe("suppressed");
  });

  it("authored body pass-through, public-suffix co.uk, dynamic href, and hidden unsubscribe via preflight", () => {
    applyTestEnv(testUrl!);
    const identity = loadSendingIdentity();

    const authoredHtml = '<p>Hi --- keep this</p><p>Unsubscribe: author line</p>';
    const authoredText = "Hi\n---\nUnsubscribe: author line";
    expect(authoredHtml).not.toContain("Example Co");

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

    const ok = runCampaignPreflight({
      subject: "Product update",
      fromName: "Example Co",
      fromEmail: "news@example.com",
      htmlBody: '<p>Update <a href="https://www.example.com">site</a></p>',
      textBody: "Update https://www.example.com",
      identity,
      requirePublicHttps: true,
    });
    expect(ok.ok).toBe(true);

    const bad = runCampaignPreflight({
      subject: "Product update",
      fromName: "Example Co",
      fromEmail: "news@example.com",
      htmlBody:
        '<p>Hi <a href="{{first_name}}">x</a></p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
      textBody: "Hi\nUnsubscribe: {{unsubscribe_url}}",
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

  it("email change keeps the contact active", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "before@example.com",
      actorUserId: userId,
    });

    const updated = await updateContact({
      contactId,
      actorUserId: userId,
      email: "after@example.com",
    });
    expect(updated.status).toBe("active");
    expect(updated.email).toBe("after@example.com");
    expect(updated.first_name).toBe("Pat");
    expect(updated.last_name).toBe("Lee");

    const row = await query<{ status: string }>(`SELECT status FROM contacts WHERE id = $1`, [
      contactId,
    ]);
    expect(row.rows[0].status).toBe("active");

    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'contact_updated'`,
      [contactId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("concurrent suppression during email change wins", async () => {
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "race-email@example.com",
      actorUserId: userId,
    });

    await applySuppression("new-race@example.com", "complaint", "pg_test");
    const updated = await updateContact({
      contactId,
      actorUserId: userId,
      email: "new-race@example.com",
    });
    expect(updated.status).toBe("suppressed");
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

  it("campaign mutations are rejected after launch prepare", async () => {
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
  });

  it("protected suppressions cannot be cleared and manual removal restores active", async () => {
    const { removeSuppression } = await import("../lib/suppressions");
    const userId = await seedAdminUser();
    const listId = await seedList();
    const contactId = await seedActiveContact({
      listId,
      email: "protected@example.com",
      actorUserId: userId,
    });
    await applySuppression("protected@example.com", "complaint", "pg_test");
    const flag = await query<{ protected: boolean }>(
      `SELECT protected FROM suppressions WHERE email = 'protected@example.com'`,
    );
    expect(flag.rows[0]?.protected).toBe(true);

    await expect(
      removeSuppression({
        email: "protected@example.com",
        actorUserId: userId,
      }),
    ).rejects.toThrow(/protected|complaint|cannot/i);

    const contact = await query<{ status: string }>(`SELECT status FROM contacts WHERE id = $1`, [
      contactId,
    ]);
    expect(contact.rows[0].status).toBe("suppressed");

    await applySuppression("manual-clear@example.com", "manual", "pg_test");
    await seedActiveContact({
      listId,
      email: "manual-clear@example.com",
      actorUserId: userId,
    });
    const cleared = await removeSuppression({
      email: "manual-clear@example.com",
      actorUserId: userId,
    });
    expect(cleared.removed).toBe(true);
    const restored = await query<{ status: string }>(
      `SELECT status FROM contacts WHERE email = 'manual-clear@example.com'`,
    );
    expect(restored.rows[0].status).toBe("active");
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

    process.env.SENDSTACK_DELIVERY_MODE = "smtp";
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
    process.env.SENDSTACK_DELIVERY_MODE = "smtp";
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
