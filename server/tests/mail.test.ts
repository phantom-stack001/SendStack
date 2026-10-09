import { describe, expect, it } from "vitest";

import { visibleDashboardNavGroups } from "../../src/lib/dashboard-nav.js";
import {
  assertAuthorizedParties,
  loadMailConfig,
  toPublicAccount,
} from "../mail/configuration.js";
import { friendlyMailError, redactSecrets } from "../mail/errors.js";
import { sanitizeInboundHtml } from "../mail/html.js";
import { messagePageRange } from "../mail/pagination.js";
import { assessTestSendRateLimit } from "../mail/rate-limit.js";
import { findSentMailbox } from "../mail/sent-folder.js";
import { queueEnvSchema } from "../queue/configuration.js";

const SECRET = "mailbox-secret-value";

function validEnv(overrides: Record<string, string> = {}) {
  return {
    SPACEMAIL_SMTP_HOST: "mail.spacemail.com",
    SPACEMAIL_SMTP_PORT: "587",
    SPACEMAIL_SMTP_SECURE: "false",
    SPACEMAIL_IMAP_HOST: "mail.spacemail.com",
    SPACEMAIL_IMAP_PORT: "993",
    SPACEMAIL_IMAP_SECURE: "true",
    SPACEMAIL_EMAIL: "info@ctn-sk.com",
    SPACEMAIL_PASSWORD: SECRET,
    SPACEMAIL_TEST_RECIPIENT: "info@ctn-sk.com",
    SPACEMAIL_SENDER_NAME: "CTN Slovakia",
    ...overrides,
  };
}

describe("mailbox configuration", () => {
  it("accepts the official STARTTLS and implicit TLS combinations", () => {
    const startTls = loadMailConfig(validEnv());
    expect(startTls.ok).toBe(true);
    if (startTls.ok) {
      expect(startTls.config.smtpPort).toBe(587);
      expect(startTls.config.smtpSecure).toBe(false);
      expect(JSON.stringify(toPublicAccount(startTls.config))).not.toContain(SECRET);
    }

    const implicit = loadMailConfig(
      validEnv({
        SPACEMAIL_SMTP_PORT: "465",
        SPACEMAIL_SMTP_SECURE: "true",
      }),
    );
    expect(implicit.ok).toBe(true);
  });

  it("rejects missing credentials, the wrong host, and cleartext ports", () => {
    expect(loadMailConfig(validEnv({ SPACEMAIL_PASSWORD: "" })).ok).toBe(false);
    expect(loadMailConfig(validEnv({ SPACEMAIL_SMTP_HOST: "smtp.example.com" }))).toEqual({
      ok: false,
      reason: "host",
    });
    expect(loadMailConfig(validEnv({ SPACEMAIL_SMTP_PORT: "25", SPACEMAIL_SMTP_SECURE: "false" }))).toEqual({
      ok: false,
      reason: "smtp",
    });
    expect(loadMailConfig(validEnv({ SPACEMAIL_IMAP_PORT: "143", SPACEMAIL_IMAP_SECURE: "false" }))).toEqual({
      ok: false,
      reason: "imap",
    });
  });

  it("allows only the configured mailbox and authorized recipient", () => {
    const loaded = loadMailConfig(validEnv());
    if (!loaded.ok) throw new Error("expected config");
    expect(() =>
      assertAuthorizedParties(loaded.config, {
        from: loaded.config.email,
        to: loaded.config.testRecipient,
      }),
    ).not.toThrow();
    expect(() =>
      assertAuthorizedParties(loaded.config, {
        from: loaded.config.email,
        to: "other@example.com",
      }),
    ).toThrow(/authorized test recipient/);
  });
});

describe("mailbox safety", () => {
  it("redacts secrets and does not return them in friendly errors", () => {
    expect(redactSecrets(`login failed for ${SECRET}`, [SECRET])).toBe("login failed for [redacted]");
    const error = Object.assign(new Error(`authentication failed: ${SECRET}`), { code: "EAUTH" });
    const friendly = friendlyMailError(error, "smtp");
    expect(friendly).toMatch(/credentials/i);
    expect(friendly).not.toContain(SECRET);
  });

  it("strips scripts, remote images, and unsafe links from message HTML", () => {
    const sanitized = sanitizeInboundHtml(
      '<p onclick="alert(1)">Hello</p><script>alert(1)</script><img src="https://tracker.example/pixel.gif"><a href="javascript:alert(1)">bad</a><a href="https://ctn-sk.com">site</a>',
    );
    expect(sanitized).not.toContain("alert(1)");
    expect(sanitized).not.toContain("tracker.example");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).toContain("Hello");
    expect(sanitized).toContain("https://ctn-sk.com");
  });

  it("limits test sends and finds a sent folder without assuming a copy already exists", () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    expect(
      assessTestSendRateLimit(
        [{ createdAt: new Date("2026-10-09T11:59:30.000Z") }],
        now,
      ).allowed,
    ).toBe(false);
    expect(
      assessTestSendRateLimit(
        [
          { createdAt: new Date("2026-10-09T11:10:00.000Z") },
          { createdAt: new Date("2026-10-09T11:30:00.000Z") },
          { createdAt: new Date("2026-10-09T11:50:00.000Z") },
        ],
        now,
      ).allowed,
    ).toBe(false);
    expect(assessTestSendRateLimit([], now).allowed).toBe(true);

    expect(
      findSentMailbox([
        { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
        { path: "Sent", name: "Sent", specialUse: "\\Sent" },
      ])?.path,
    ).toBe("Sent");
    expect(findSentMailbox([{ path: "INBOX", name: "INBOX" }])).toBeNull();
  });

  it("pages newest messages first", () => {
    expect(messagePageRange(45, 1, 20)).toEqual({ start: 26, end: 45 });
    expect(messagePageRange(45, 3, 20)).toEqual({ start: 1, end: 5 });
    expect(messagePageRange(45, 4, 20)).toBeNull();
  });

  it("keeps campaign queue processing simulation-only", () => {
    const parsed = queueEnvSchema.safeParse({
      QUEUE_ENABLED: "true",
      QUEUE_SIMULATION_ONLY: "false",
      REDIS_URL: "redis://127.0.0.1:6379",
    });
    expect(parsed.success).toBe(false);
  });

  it("shows inbox and sent only for mailbox permission", () => {
    const adminTitles = visibleDashboardNavGroups(new Set(["mailbox.read", "users.read"])).flatMap((group) =>
      group.items.map((item) => item.title),
    );
    const userTitles = visibleDashboardNavGroups(new Set<string>()).flatMap((group) =>
      group.items.map((item) => item.title),
    );
    expect(adminTitles).toEqual(
      expect.arrayContaining(["Compose", "Inbox", "Sent", "Drafts", "Campaigns", "Queue", "Settings"]),
    );
    expect(userTitles).not.toContain("Inbox");
    expect(userTitles).not.toContain("Sent");
    expect(userTitles).toContain("Drafts");
  });
});
