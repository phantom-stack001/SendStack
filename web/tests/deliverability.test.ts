import { createHmac } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_MAX_FILE_BYTES,
  validateCampaignAttachment,
} from "../lib/attachments";
import {
  canTransitionMessageStatus,
  canTransitionRecipientStatus,
} from "../lib/delivery-status";
import { identityComplianceGaps, isTestRecipientAllowed, loadSendingIdentity } from "../lib/sending-identity";
import { applyComplianceFooter } from "../lib/compliance-footer";
import { runCampaignPreflight } from "../lib/preflight";
import { isSpecialUseRecipientDomain, validateLiveRecipient } from "../lib/recipients";
import { requiredPermission } from "../lib/rbac";
import { liveSendBootIssues, validateProductionEnv } from "../lib/env";
import { buildIdempotencyKey } from "../lib/live-send";
import { buildSmtpMailContract, smtpAcceptanceAmbiguous } from "../lib/providers/smtp";
import {
  buildSentAppendSource,
  pickSentFolderPath,
  setMailboxClientFactoryForTests,
} from "../lib/mailbox";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  setMailboxClientFactoryForTests(null);
  vi.restoreAllMocks();
});

function setIdentityEnv(overrides: Record<string, string> = {}) {
  process.env.SENDSTACK_FROM_EMAIL = "news@example.com";
  process.env.SENDSTACK_REPLY_TO_EMAIL = "hello@example.com";
  process.env.SENDSTACK_ALLOWED_LINK_DOMAINS = "example.com,www.example.com";
  process.env.SENDSTACK_TEST_RECIPIENT_ALLOWLIST = "ops@example.com,qa@example.com";
  process.env.SENDSTACK_PUBLIC_URL = "https://app.example.com";
  process.env.SENDSTACK_HEALTH_MIN_SAMPLE = "50";
  process.env.SENDSTACK_HEALTH_MAX_BOUNCE_RATE = "0.05";
  process.env.SENDSTACK_HEALTH_MAX_COMPLAINT_RATE = "0.001";
  process.env.SENDSTACK_HEALTH_MAX_UNSUBSCRIBE_RATE = "0.02";
  process.env.SENDSTACK_HEALTH_MAX_DELAY_RATE = "0.2";
  process.env.SENDSTACK_HEALTH_MAX_FAILURE_RATE = "0.05";
  Object.assign(process.env, overrides);
}

describe("special-use recipient domains", () => {
  it("rejects .test .invalid .local .localhost and .example", () => {
    for (const email of [
      "user@example.test",
      "a@foo.invalid",
      "b@host.local",
      "c@localhost",
      "d@something.example",
      "e@example.com",
    ]) {
      expect(isSpecialUseRecipientDomain(email)).toBe(true);
      expect(validateLiveRecipient(email).ok).toBe(false);
    }
    expect(validateLiveRecipient("person@mail.example.com").ok).toBe(false);
    expect(validateLiveRecipient("person@contoso.com").ok).toBe(true);
  });
});

describe("test recipient allowlist", () => {
  it("allows only configured exact addresses", () => {
    setIdentityEnv();
    const identity = loadSendingIdentity();
    expect(isTestRecipientAllowed("ops@example.com", identity)).toBe(true);
    expect(isTestRecipientAllowed("other@example.com", identity)).toBe(false);
  });
});

describe("fixed from and reply-to identity", () => {
  it("reports gaps when identity settings are absent", () => {
    delete process.env.SENDSTACK_FROM_EMAIL;
    delete process.env.SENDSTACK_REPLY_TO_EMAIL;
    delete process.env.SENDSTACK_ALLOWED_LINK_DOMAINS;
    const gaps = identityComplianceGaps();
    const gapIds = gaps.map((gap) => gap.id);
    expect(gapIds).toEqual(expect.arrayContaining(["from_email"]));
    expect(gapIds).not.toContain("reply_to");
    expect(gapIds).not.toContain("allowed_link_domains");
    expect(gapIds).not.toContain("company_name");
    expect(gapIds).not.toContain("postal_address");
  });

  it("loads configured identity values", () => {
    setIdentityEnv();
    const identity = loadSendingIdentity();
    expect(identity.fromEmail).toBe("news@example.com");
    expect(identity.replyToEmail).toBe("hello@example.com");
    expect(identity.allowedLinkDomains).toContain("example.com");
  });
});

describe("campaign preflight", () => {
  it("allows Spacemail-style content and rejects only unsafe HTML", () => {
    setIdentityEnv();
    delete process.env.SENDSTACK_ALLOWED_LINK_DOMAINS;
    delete process.env.SENDSTACK_REPLY_TO_EMAIL;

    const withExternalLink = runCampaignPreflight({
      subject: "RE: Payment advice",
      fromName: "Billing",
      fromEmail: "news@example.com",
      htmlBody: '<p>Replace this text <a href="https://evil.example.net">x</a></p>',
      textBody: "Replace this text",
      attachmentExtensions: ["zip"],
    });
    expect(withExternalLink.ok).toBe(true);

    const unsafe = runCampaignPreflight({
      subject: "March product update",
      fromName: "Example Operator",
      fromEmail: "news@example.com",
      htmlBody: '<p>Hi</p><script>alert(1)</script>',
      textBody: "Hi",
    });
    expect(unsafe.ok).toBe(false);

    const plainOnly = runCampaignPreflight({
      subject: "March product update",
      fromName: "Example Operator",
      fromEmail: "news@example.com",
      htmlBody: "",
      textBody: "Hello {{first_name}}\nRead more: https://www.example.com/updates",
    });
    expect(plainOnly.ok).toBe(true);
  });
});

describe("attachments without archives", () => {
  it("rejects zip and validates magic bytes for pdf/png", () => {
    const zip = validateCampaignAttachment({
      filename: "pack.zip",
      contentType: "application/zip",
      byteSize: 100,
      existingCount: 0,
      existingTotalBytes: 0,
      bytes: Buffer.from("PK\u0003\u0004"),
    });
    expect(zip.ok).toBe(false);

    const pdf = validateCampaignAttachment({
      filename: "guide.pdf",
      contentType: "application/pdf",
      byteSize: 12,
      existingCount: 0,
      existingTotalBytes: 0,
      bytes: Buffer.from("%PDF-1.4 hello"),
    });
    expect(pdf.ok).toBe(true);

    const fakePng = validateCampaignAttachment({
      filename: "hero.png",
      contentType: "image/png",
      byteSize: 8,
      existingCount: 0,
      existingTotalBytes: 0,
      bytes: Buffer.from("notapng!"),
    });
    expect(fakePng.ok).toBe(false);

    expect(
      validateCampaignAttachment({
        filename: "big.pdf",
        contentType: "application/pdf",
        byteSize: ATTACHMENT_MAX_FILE_BYTES + 1,
        existingCount: 0,
        existingTotalBytes: 0,
        bytes: Buffer.from("%PDF-1.4"),
      }).ok,
    ).toBe(false);
  });
});

describe("SMTP acceptance ambiguity", () => {
  it("treats connection drops as ambiguous and ordinary errors as definite", () => {
    expect(smtpAcceptanceAmbiguous(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(smtpAcceptanceAmbiguous(new Error("SMTP 550 rejected"))).toBe(false);
  });
});

describe("Spacemail SMTP mail contract", () => {
  it("uses the mailbox as From and envelope without a client Message-ID", () => {
    const contract = buildSmtpMailContract({
      mailbox: "News@Example.COM",
      to: "person@customer.com",
      fromName: "SendStack News",
      fromEmail: "news@example.com",
      text: "Hello",
    });
    expect(contract.mailbox).toBe("news@example.com");
    expect(contract.envelopeFrom).toBe("news@example.com");
    expect(contract.fromHeader).toBe("SendStack News <news@example.com>");
    expect(contract.to).toBe("person@customer.com");
    expect(contract.text).toBe("Hello");
    expect(contract.replyTo).toBeUndefined();
    expect(contract).not.toHaveProperty("messageId");
  });

  it("rejects a From address that is not the Spacemail mailbox", () => {
    expect(() =>
      buildSmtpMailContract({
        mailbox: "news@example.com",
        to: "person@customer.com",
        fromName: "News",
        fromEmail: "other@example.com",
        text: "Hello",
      }),
    ).toThrow(/Spacemail mailbox/);
  });

  it("addresses exactly one recipient and keeps text-only bodies", () => {
    const contract = buildSmtpMailContract({
      mailbox: "news@example.com",
      to: "only@customer.com",
      fromName: "News",
      fromEmail: "news@example.com",
      text: "Plain only",
    });
    expect(contract.to).toBe("only@customer.com");
    expect(contract.to.includes(",")).toBe(false);
    expect(contract.html).toBeUndefined();
    expect(contract.text).toBe("Plain only");
  });
});

describe("mailbox From launch gate", () => {
  it("reports a gap when FROM_EMAIL does not match the Spacemail mailbox", () => {
    setIdentityEnv({
      SENDSTACK_FROM_EMAIL: "other@example.com",
      SENDSTACK_SMTP_USERNAME: "news@example.com",
    });
    const gaps = identityComplianceGaps();
    expect(gaps.some((gap) => gap.id === "mailbox_from")).toBe(true);
  });
});

describe("status transitions", () => {
  it("protects terminal states", () => {
    expect(canTransitionMessageStatus("bounced", "delivered")).toBe(false);
    expect(canTransitionMessageStatus("complained", "submitted")).toBe(false);
    expect(canTransitionMessageStatus("suppressed", "delivered")).toBe(false);
    expect(canTransitionMessageStatus("submitted", "delivered")).toBe(true);
    expect(canTransitionRecipientStatus("bounced", "sent")).toBe(false);
    expect(canTransitionRecipientStatus("processing", "sent")).toBe(true);
  });
});

describe("rbac for test sends and delivery health", () => {
  it("restricts live test sends to administrators", () => {
    expect(requiredPermission("POST", "/api/campaigns/cam_1/test-send")).toBe("campaigns.send");
    expect(requiredPermission("GET", "/api/delivery-health")).toBe("sending.view");
  });
});

describe("production readiness identity gate", () => {
  it("logs live-send gaps without crashing boot when identity settings are missing", () => {
    process.env.VERCEL_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.SENDSTACK_SESSION_SECRET = "x".repeat(40);
    process.env.SENDSTACK_LIVE_SEND_ENABLED = "true";
    process.env.SENDSTACK_SMTP_HOST = "mail.spacemail.com";
    process.env.SENDSTACK_SMTP_USERNAME = "news@example.com";
    process.env.SENDSTACK_SMTP_PASSWORD = "secret";
    process.env.CRON_SECRET = "cron_test_secret";
    delete process.env.SENDSTACK_FROM_EMAIL;
    delete process.env.SENDSTACK_REPLY_TO_EMAIL;
    delete process.env.SENDSTACK_ALLOWED_LINK_DOMAINS;
    const issues = liveSendBootIssues();
    expect(issues.some((issue) => /identity settings/i.test(issue))).toBe(true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => validateProductionEnv()).not.toThrow();
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("identity settings"))).toBe(
      true,
    );
    errorSpy.mockRestore();
  });

  it("passes when identity and provider settings are complete", () => {
    process.env.VERCEL_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.SENDSTACK_SESSION_SECRET = "x".repeat(40);
    process.env.SENDSTACK_LIVE_SEND_ENABLED = "true";
    process.env.SENDSTACK_SMTP_HOST = "mail.spacemail.com";
    process.env.SENDSTACK_SMTP_USERNAME = "news@example.com";
    process.env.SENDSTACK_SMTP_PASSWORD = "secret";
    setIdentityEnv();
    process.env.CRON_SECRET = "cron_test_secret";
    expect(liveSendBootIssues()).toEqual([]);
    expect(() => validateProductionEnv()).not.toThrow();
  });
});

describe("plain Spacemail SMTP payload", () => {
  it("does not inject List-Unsubscribe headers and leaves Message-ID to Spacemail", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../lib/providers/smtp.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toContain("List-Unsubscribe");
    expect(source).not.toContain("List-Unsubscribe-Post");
    expect(source).not.toContain("unsubscribeUrl");
    expect(source).toContain("messageId: false");
    expect(source).toContain("secure: true");
    expect(source).toContain("buildSmtpMailContract");
  });
});

describe("mailbox Sent folder helpers", () => {
  it("picks \\Sent special-use then common Sent names", () => {
    expect(
      pickSentFolderPath([
        { path: "INBOX" },
        { path: "Archive" },
        { path: "Sent Messages", specialUse: "\\Sent" },
      ]),
    ).toBe("Sent Messages");
    expect(pickSentFolderPath([{ path: "INBOX" }, { path: "Sent Items" }])).toBe("Sent Items");
  });

  it("builds an RFC822 append source without opening IMAP", () => {
    const raw = buildSentAppendSource({
      from: "News <news@example.com>",
      to: "person@customer.com",
      subject: "Hello",
      text: "Body",
    });
    expect(raw).toContain("From: News <news@example.com>");
    expect(raw).toContain("To: person@customer.com");
    expect(raw).toContain("Subject: Hello");
    expect(raw).toContain("Body");
    expect(raw).not.toContain("List-Unsubscribe");
  });
});

describe("idempotency keys", () => {
  it("builds deterministic keys", () => {
    expect(buildIdempotencyKey(["smtp-send", "cam_1", "msg_1"])).toBe("smtp-send:cam_1:msg_1");
  });
});

describe("webhook signature fixture still valid", () => {
  it("accepts matching svix hmac", async () => {
    const { verifySvixSignature } = await import("../lib/providers/webhook");
    const secret = "whsec_" + Buffer.from("test-secret").toString("base64");
    const key = Buffer.from(secret.slice(6), "base64");
    const id = "msg_abc";
    const timestamp = "1710000000";
    const body = '{"type":"email.delivered"}';
    const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    expect(verifySvixSignature(secret, body, id, timestamp, `v1,${expected}`)).toBe(true);
  });
});
