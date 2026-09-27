import { createHmac } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_MAX_FILE_BYTES,
  validateCampaignAttachment,
} from "../lib/attachments";
import {
  canTransitionMessageStatus,
  canTransitionRecipientStatus,
  statusFromResendEvent,
} from "../lib/delivery-status";
import { identityComplianceGaps, isTestRecipientAllowed, loadSendingIdentity } from "../lib/sending-identity";
import { runCampaignPreflight } from "../lib/preflight";
import { isSpecialUseRecipientDomain, validateLiveRecipient } from "../lib/recipients";
import { requiredPermission } from "../lib/rbac";
import { validateProductionEnv } from "../lib/env";
import { buildIdempotencyKey } from "../lib/providers/resend";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function setIdentityEnv(overrides: Record<string, string> = {}) {
  process.env.SENDSTACK_FROM_EMAIL = "news@example.com";
  process.env.SENDSTACK_REPLY_TO_EMAIL = "hello@example.com";
  process.env.SENDSTACK_COMPANY_NAME = "Example Operator Ltd";
  process.env.SENDSTACK_POSTAL_ADDRESS = "1 Example Street, Example City, EX1 1AA";
  process.env.SENDSTACK_ALLOWED_LINK_DOMAINS = "example.com,www.example.com";
  process.env.SENDSTACK_TEST_RECIPIENT_ALLOWLIST = "ops@example.com,qa@example.com";
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
    delete process.env.SENDSTACK_COMPANY_NAME;
    delete process.env.SENDSTACK_POSTAL_ADDRESS;
    delete process.env.SENDSTACK_ALLOWED_LINK_DOMAINS;
    const gaps = identityComplianceGaps();
    expect(gaps.map((gap) => gap.id)).toEqual(
      expect.arrayContaining(["from_email", "reply_to", "company_name", "postal_address", "allowed_link_domains"]),
    );
  });

  it("loads configured identity values", () => {
    setIdentityEnv();
    const identity = loadSendingIdentity();
    expect(identity.fromEmail).toBe("news@example.com");
    expect(identity.replyToEmail).toBe("hello@example.com");
    expect(identity.companyName).toBe("Example Operator Ltd");
    expect(identity.allowedLinkDomains).toContain("example.com");
  });
});

describe("campaign preflight", () => {
  it("rejects placeholders, fake forwards, disallowed links, and archives", () => {
    setIdentityEnv();
    const bad = runCampaignPreflight({
      subject: "RE: Payment advice",
      fromName: "Billing",
      fromEmail: "news@example.com",
      htmlBody: '<p>Replace this text <a href="https://evil.example.net">x</a> <a href="{{unsubscribe_url}}">u</a></p>',
      textBody: "Replace this text {{unsubscribe_url}}",
      attachmentExtensions: ["zip"],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(" ")).toMatch(/RE:|FW:|placeholder|not in SENDSTACK_ALLOWED_LINK_DOMAINS|archive/i);
    }

    const good = runCampaignPreflight({
      subject: "March product update",
      fromName: "Example Operator",
      fromEmail: "news@example.com",
      htmlBody:
        '<p>Hello {{first_name}}</p><p><a href="https://www.example.com/updates">Read more</a></p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
      textBody: "Hello {{first_name}}\nRead more: https://www.example.com/updates\nUnsubscribe: {{unsubscribe_url}}",
      attachmentExtensions: ["pdf"],
    });
    expect(good.ok).toBe(true);
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

describe("provider unsubscribe preservation payload", () => {
  it("does not force a subscribed flag in the contact upsert JSON body", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../lib/providers/resend.ts", import.meta.url), "utf8"),
    );
    const start = source.indexOf("export async function upsertResendContact");
    const end = source.indexOf("export async function addContactToSegment");
    const upsertBody = source.slice(start, end);
    expect(upsertBody).toContain("first_name");
    expect(upsertBody).not.toMatch(/unsubscribed\s*:/);
  });
});

describe("webhook status transitions", () => {
  it("maps resend events and protects terminal states", () => {
    expect(statusFromResendEvent("email.delivery_delayed")).toBe("delayed");
    expect(statusFromResendEvent("email.suppressed")).toBe("suppressed");
    expect(statusFromResendEvent("email.failed")).toBe("failed");
    expect(statusFromResendEvent("email.bounced")).toBe("bounced");
    expect(statusFromResendEvent("email.complained")).toBe("complained");
    expect(statusFromResendEvent("email.sent")).toBe("submitted");
    expect(statusFromResendEvent("email.delivered")).toBe("delivered");

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
  it("fails when live sending is enabled without identity settings", () => {
    process.env.VERCEL_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.SENDSTACK_SESSION_SECRET = "x".repeat(40);
    process.env.SENDSTACK_LIVE_SEND_ENABLED = "true";
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    delete process.env.SENDSTACK_FROM_EMAIL;
    delete process.env.SENDSTACK_REPLY_TO_EMAIL;
    delete process.env.SENDSTACK_COMPANY_NAME;
    delete process.env.SENDSTACK_POSTAL_ADDRESS;
    delete process.env.SENDSTACK_ALLOWED_LINK_DOMAINS;
    expect(() => validateProductionEnv()).toThrow(/identity\/compliance/i);
  });

  it("passes when identity and provider settings are complete", () => {
    process.env.VERCEL_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.SENDSTACK_SESSION_SECRET = "x".repeat(40);
    process.env.SENDSTACK_LIVE_SEND_ENABLED = "true";
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    setIdentityEnv();
    expect(() => validateProductionEnv()).not.toThrow();
  });
});

describe("list-unsubscribe headers", () => {
  it("documents one-click header pair in send payload builder", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../lib/providers/resend.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("List-Unsubscribe");
    expect(source).toContain("List-Unsubscribe-Post");
    expect(source).toContain("List-Unsubscribe=One-Click");
    expect(source).toContain("Idempotency-Key");
    expect(source).toContain("/cancel");
  });
});

describe("idempotency keys", () => {
  it("builds deterministic keys", () => {
    expect(buildIdempotencyKey(["broadcast-send", "cam_1", "bcast_1"])).toBe("broadcast-send:cam_1:bcast_1");
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
