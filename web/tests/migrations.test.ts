import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const drizzleDir = join(__dirname, "../drizzle");

describe("migration idempotence and ordering", () => {
  it("includes 0009 after 0008 without rewriting prior migrations", () => {
    const files = readdirSync(drizzleDir).filter((name) => name.endsWith(".sql")).sort();
    expect(files).toContain("0005_deliverability_hardening.sql");
    expect(files).toContain("0006_consent_volume_launch_hardening.sql");
    expect(files).toContain("0008_drop_consent_gate.sql");
    expect(files).toContain("0009_spacemail_parity.sql");
    expect(files.indexOf("0006_consent_volume_launch_hardening.sql")).toBeGreaterThan(
      files.indexOf("0005_deliverability_hardening.sql"),
    );
    expect(files.indexOf("0008_drop_consent_gate.sql")).toBeGreaterThan(
      files.indexOf("0007_submission_state_machine.sql"),
    );
    expect(files.indexOf("0009_spacemail_parity.sql")).toBeGreaterThan(
      files.indexOf("0008_drop_consent_gate.sql"),
    );
  });

  it("0008 drops the active-consent check and restores the active default", () => {
    const sql = readFileSync(join(drizzleDir, "0008_drop_consent_gate.sql"), "utf8");
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS contacts_active_requires_consent_check/);
    expect(sql).toMatch(/SET DEFAULT 'active'/);
    expect(sql).toMatch(/status = 'pending_consent'/);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it("0009 makes unsubscribe tokens optional and drops broadcast/attachment leftovers", () => {
    const sql = readFileSync(join(drizzleDir, "0009_spacemail_parity.sql"), "utf8");
    expect(sql).toMatch(/unsubscribe_token DROP NOT NULL/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS provider_events/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS campaign_attachments/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS provider_broadcast_id/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS consent_evidence/);
    expect(sql).toMatch(/CHECK \(status IN \('active', 'suppressed'\)\)/);
  });

  it("0006 preserves historical campaign data (additive SQL only)", () => {
    const sql = readFileSync(join(drizzleDir, "0006_consent_volume_launch_hardening.sql"), "utf8");
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM campaigns/i);
    expect(sql).not.toMatch(/DELETE FROM messages/i);
    expect(sql).toMatch(/pending_consent/);
    expect(sql).toMatch(/daily_volume_reservations/);
    expect(sql).toMatch(/launch_jobs/);
    expect(sql).toMatch(/UPDATE contacts[\s\S]*pending_consent/);
  });

  it("prior migrations remain unchanged byte-stable markers", () => {
    const sql5 = readFileSync(join(drizzleDir, "0005_deliverability_hardening.sql"), "utf8");
    expect(sql5).toMatch(/blocked BOOLEAN/);
    expect(sql5).toMatch(/idempotency_key/);
  });
});
