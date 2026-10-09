import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const drizzleDir = join(__dirname, "../drizzle");

describe("migration idempotence and ordering", () => {
  it("includes 0006 after 0005 and 0008 after 0007 without rewriting prior migrations", () => {
    const files = readdirSync(drizzleDir).filter((name) => name.endsWith(".sql")).sort();
    expect(files).toContain("0005_deliverability_hardening.sql");
    expect(files).toContain("0006_consent_volume_launch_hardening.sql");
    expect(files).toContain("0008_drop_consent_gate.sql");
    expect(files.indexOf("0006_consent_volume_launch_hardening.sql")).toBeGreaterThan(
      files.indexOf("0005_deliverability_hardening.sql"),
    );
    expect(files.indexOf("0008_drop_consent_gate.sql")).toBeGreaterThan(
      files.indexOf("0007_submission_state_machine.sql"),
    );
  });

  it("0008 drops the active-consent check and restores the active default", () => {
    const sql = readFileSync(join(drizzleDir, "0008_drop_consent_gate.sql"), "utf8");
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS contacts_active_requires_consent_check/);
    expect(sql).toMatch(/SET DEFAULT 'active'/);
    expect(sql).toMatch(/status = 'pending_consent'/);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it("0006 preserves historical attachment and campaign data (additive SQL only)", () => {
    const sql = readFileSync(join(drizzleDir, "0006_consent_volume_launch_hardening.sql"), "utf8");
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM campaigns/i);
    expect(sql).not.toMatch(/DELETE FROM messages/i);
    expect(sql).not.toMatch(/DELETE FROM campaign_attachments/i);
    expect(sql).toMatch(/pending_consent/);
    expect(sql).toMatch(/daily_volume_reservations/);
    expect(sql).toMatch(/launch_jobs/);
    // Historical contacts are demoted, not deleted.
    expect(sql).toMatch(/UPDATE contacts[\s\S]*pending_consent/);
  });

  it("prior migrations remain unchanged byte-stable markers", () => {
    const sql5 = readFileSync(join(drizzleDir, "0005_deliverability_hardening.sql"), "utf8");
    expect(sql5).toMatch(/blocked BOOLEAN/);
    expect(sql5).toMatch(/idempotency_key/);
  });
});
