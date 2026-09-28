import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query, resetPool } from "../lib/db";
import { hashPassword, makeId } from "../lib/ids";
import {
  applyMigrationFile,
  applyMigrations,
  applyTestEnv,
  canConnectToTestDatabase,
  resolveTestDatabaseUrl,
  wipePublicSchema,
} from "./pg-test-utils";

const testUrl = resolveTestDatabaseUrl();
const dbAvailable = await canConnectToTestDatabase(testUrl);

describe.skipIf(!dbAvailable)("PostgreSQL migrations (0001→0006)", () => {
  beforeAll(async () => {
    applyTestEnv(testUrl);
    await resetPool();
  });

  afterAll(async () => {
    await resetPool();
  });

  it("migrates an empty database through all drizzle files", async () => {
    await wipePublicSchema();
    await resetPool();
    const applied = await applyMigrations();
    const files = readdirSync(join(__dirname, "../drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(applied).toEqual(files);

    const migrations = await query<{ id: string }>(
      `SELECT id FROM schema_migrations ORDER BY id`,
    );
    expect(migrations.rows.map((row) => row.id)).toEqual(files);
  });

  it("preserves 0005-era rows when applying 0006 and keeps constraints", async () => {
    await wipePublicSchema();
    await resetPool();

    const drizzleDir = join(__dirname, "../drizzle");
    const through0005 = readdirSync(drizzleDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => name <= "0005_deliverability_hardening.sql");

    for (const file of through0005) {
      await applyMigrationFile(file);
    }

    const userId = makeId("usr");
    const listId = makeId("lst");
    const contactId = makeId("con");
    const campaignId = makeId("cam");
    const recipientId = makeId("rec");
    const messageId = makeId("msg");
    const attachmentId = makeId("att");

    await query(
      `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at, updated_at)
       VALUES ($1, $2, 'Legacy Admin', 'admin', $3, TRUE, FALSE, NOW(), NOW())`,
      [userId, `legacy_${userId}@example.com`, hashPassword("LegacyPass123!")],
    );
    await query(`INSERT INTO lists (id, name, description, created_at) VALUES ($1, $2, 'legacy', NOW())`, [
      listId,
      `Legacy list ${listId}`,
    ]);
    // 0005-era active contact without consent evidence columns.
    await query(
      `INSERT INTO contacts
         (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
       VALUES ($1, $2, 'Legacy', 'Contact', 'active', 'manual', NOW(), NOW(), NOW())`,
      [contactId, `legacy_${contactId}@example.com`],
    );
    await query(`INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`, [
      listId,
      contactId,
    ]);
    await query(
      `INSERT INTO suppressions (email, reason, source, created_at)
       VALUES ($1, 'unsubscribe', 'legacy_seed', NOW())`,
      [`suppressed_${contactId}@example.com`],
    );
    await query(
      `INSERT INTO campaigns
         (id, name, subject, from_name, from_email, content_mode, content_json,
          html_body, text_body, list_id, status, created_by, created_at, updated_at)
       VALUES ($1, 'Legacy campaign', 'Hello', 'Legacy', 'news@example.com', 'custom_html', '{}',
               '<p>Hi</p>', 'Hi', $2, 'completed', $3, NOW(), NOW())`,
      [campaignId, listId, userId],
    );
    await query(
      `INSERT INTO campaign_recipients
         (id, campaign_id, contact_id, email, status, message_id, queued_at, sent_at)
       VALUES ($1, $2, $3, $4, 'sent', $5, NOW(), NOW())`,
      [recipientId, campaignId, contactId, `legacy_${contactId}@example.com`, messageId],
    );
    await query(
      `INSERT INTO messages
         (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email,
          html_body, text_body, status, unsubscribe_token, created_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'Hello', 'news@example.com',
               '<p>Hi</p>', 'Hi', 'delivered', $6, NOW(), $7)`,
      [
        messageId,
        campaignId,
        recipientId,
        contactId,
        `legacy_${contactId}@example.com`,
        makeId("tok"),
        `legacy:${campaignId}:${contactId}`,
      ],
    );
    await query(
      `INSERT INTO campaign_attachments
         (id, campaign_id, filename, content_type, byte_size, content, created_at, blocked)
       VALUES ($1, $2, 'report.pdf', 'application/pdf', 4, decode('deadbeef', 'hex'), NOW(), FALSE)`,
      [attachmentId, campaignId],
    );

    const beforeCampaigns = await query(`SELECT COUNT(*)::int AS count FROM campaigns`);
    const beforeMessages = await query(`SELECT COUNT(*)::int AS count FROM messages`);
    const beforeAttachments = await query(`SELECT COUNT(*)::int AS count FROM campaign_attachments`);
    const beforeSuppressions = await query(`SELECT COUNT(*)::int AS count FROM suppressions`);

    await applyMigrationFile("0006_consent_volume_launch_hardening.sql");

    const contact = await query<{ status: string; consent_evidence: string | null }>(
      `SELECT status, consent_evidence FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(contact.rows[0]?.status).toBe("pending_consent");

    const afterCampaigns = await query(`SELECT COUNT(*)::int AS count FROM campaigns`);
    const afterMessages = await query(`SELECT COUNT(*)::int AS count FROM messages`);
    const afterAttachments = await query(`SELECT COUNT(*)::int AS count FROM campaign_attachments`);
    const afterSuppressions = await query(`SELECT COUNT(*)::int AS count FROM suppressions`);
    expect(Number(afterCampaigns.rows[0].count)).toBe(Number(beforeCampaigns.rows[0].count));
    expect(Number(afterMessages.rows[0].count)).toBe(Number(beforeMessages.rows[0].count));
    expect(Number(afterAttachments.rows[0].count)).toBe(Number(beforeAttachments.rows[0].count));
    expect(Number(afterSuppressions.rows[0].count)).toBe(Number(beforeSuppressions.rows[0].count));

    const attachment = await query<{ filename: string }>(
      `SELECT filename FROM campaign_attachments WHERE id = $1`,
      [attachmentId],
    );
    expect(attachment.rows[0]?.filename).toBe("report.pdf");

    const consentCheck = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'contacts_active_requires_consent_check'`,
    );
    expect(consentCheck.rows[0]?.conname).toBe("contacts_active_requires_consent_check");

    const launchIdx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'launch_jobs_one_active_per_campaign'`,
    );
    expect(launchIdx.rows[0]?.indexname).toBe("launch_jobs_one_active_per_campaign");

    const volumeDay = await query<{ reserved_units: string }>(
      `SELECT reserved_units::int AS reserved_units FROM daily_volume_counters
        WHERE day_utc = (NOW() AT TIME ZONE 'UTC')::date`,
    );
    expect(Number(volumeDay.rows[0]?.reserved_units ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("running migrate twice is a no-op and preserves historical rows", async () => {
    const before = await query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);
    const campaignCount = await query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM campaigns`);
    const messageCount = await query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM messages`);

    const appliedAgain = await applyMigrations();
    expect(appliedAgain).toEqual([]);

    const after = await query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);
    expect(after.rows.map((row) => row.id)).toEqual(before.rows.map((row) => row.id));

    const campaignCountAfter = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM campaigns`,
    );
    const messageCountAfter = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM messages`,
    );
    expect(Number(campaignCountAfter.rows[0].count)).toBe(Number(campaignCount.rows[0].count));
    expect(Number(messageCountAfter.rows[0].count)).toBe(Number(messageCount.rows[0].count));

    // 0006 SQL itself remains idempotent when re-executed directly.
    const sql6 = readFileSync(
      join(__dirname, "../drizzle/0006_consent_volume_launch_hardening.sql"),
      "utf8",
    );
    await query(sql6);

    const consentCheck = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'contacts_active_requires_consent_check'`,
    );
    expect(consentCheck.rows[0]?.conname).toBe("contacts_active_requires_consent_check");
  });
});
