import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProductionSessionCookie } from "../lib/env";
import {
  canTransitionMessageStatus,
  canTransitionRecipientStatus,
} from "../lib/delivery-status";
import { loadDeliveryHealthThresholds } from "../lib/delivery-health";
import {
  hasVisibleUnsubscribe,
  runCampaignPreflight,
  validateAllowedLinkDomains,
  validateCampaignLink,
} from "../lib/preflight";
import { loadSendingIdentity } from "../lib/sending-identity";
import { DEFAULT_LAUNCH_CHUNK_SIZE } from "../lib/launch-jobs";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function setIdentityEnv() {
  process.env.SENDSTACK_FROM_EMAIL = "news@contoso.com";
  process.env.SENDSTACK_REPLY_TO_EMAIL = "hello@contoso.com";
  process.env.SENDSTACK_ALLOWED_LINK_DOMAINS = "contoso.com,www.contoso.com";
  process.env.SENDSTACK_PUBLIC_URL = "https://app.contoso.com";
}

describe("message status ranking", () => {
  it("allows complaint to overwrite bounce and rejects delivered regression", () => {
    expect(canTransitionMessageStatus("bounced", "complained")).toBe(true);
    expect(canTransitionMessageStatus("delivered", "submitted")).toBe(false);
    expect(canTransitionMessageStatus("complained", "bounced")).toBe(false);
  });
});

describe("fail-closed link validation", () => {
  it("rejects protocol-relative, malformed, encoded-hostile, and disallowed hosts", () => {
    const allowed = ["contoso.com"];
    expect(validateCampaignLink("//evil.example/phish", allowed).ok).toBe(false);
    expect(validateCampaignLink("https://evil.example/x", allowed).ok).toBe(false);
    expect(validateCampaignLink("javascript:alert(1)", allowed).ok).toBe(false);
    expect(validateCampaignLink("not a url", allowed).ok).toBe(false);
    expect(validateCampaignLink("https://www.contoso.com/ok", allowed).ok).toBe(true);
    expect(validateCampaignLink("{{unsubscribe_url}}", allowed).ok).toBe(true);
  });

  it("rejects dangerously broad allowlist entries including PSL public suffixes", () => {
    expect(validateAllowedLinkDomains(["com"]).length).toBeGreaterThan(0);
    expect(validateAllowedLinkDomains(["example"]).length).toBeGreaterThan(0);
    expect(validateAllowedLinkDomains(["co.uk"]).length).toBeGreaterThan(0);
    expect(validateAllowedLinkDomains(["co.jp"]).length).toBeGreaterThan(0);
    expect(validateAllowedLinkDomains(["github.io"]).length).toBeGreaterThan(0);
    expect(validateAllowedLinkDomains(["contoso.com"])).toEqual([]);
    expect(validateAllowedLinkDomains(["example.co.uk"])).toEqual([]);
    expect(validateAllowedLinkDomains(["myorg.github.io"])).toEqual([]);
  });

  it("rejects unsafe merge tokens in hrefs", () => {
    const allowed = ["contoso.com"];
    expect(validateCampaignLink("{{first_name}}", allowed).ok).toBe(false);
    expect(validateCampaignLink("{{unsubscribe_url}}", allowed).ok).toBe(true);
  });

  it("rejects unquoted and comment-only unsubscribe as not visible", () => {
    expect(hasVisibleUnsubscribe("<!-- {{unsubscribe_url}} -->", "hi")).toBe(false);
    expect(
      hasVisibleUnsubscribe(
        '<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
        "Unsubscribe: {{unsubscribe_url}}",
      ),
    ).toBe(true);
  });
});

describe("authored body pass-through", () => {
  it("preflight does not require unsubscribe or company footer content", () => {
    setIdentityEnv();
    const result = runCampaignPreflight({
      subject: "Hello",
      fromName: "Ops",
      fromEmail: "news@contoso.com",
      htmlBody: "<p>Hi</p>",
      textBody: "Hi",
      identity: loadSendingIdentity(),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a production session cookie unless it is Secure", () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    delete process.env.VERCEL_ENV;
    delete process.env.SENDSTACK_COOKIE_SECURE;
    process.env.SENDSTACK_PUBLIC_URL = "http://insecure.example";
    expect(() => assertProductionSessionCookie()).toThrow(/Secure/);
    process.env.SENDSTACK_PUBLIC_URL = "https://app.example.com";
    expect(() => assertProductionSessionCookie()).not.toThrow();
  });
});

describe("universal preflight including live tests", () => {
  it("still rejects javascript: links while allowing Spacemail-style subjects", () => {
    setIdentityEnv();
    delete process.env.SENDSTACK_ALLOWED_LINK_DOMAINS;
    const ok = runCampaignPreflight({
      subject: "FW: invoice",
      fromName: "Ops",
      fromEmail: "news@contoso.com",
      htmlBody: '<p>Replace this text <a href="https://evil.example">x</a></p>',
      textBody: "Replace this text",
      identity: loadSendingIdentity(),
      requirePublicHttps: true,
    });
    expect(ok.ok).toBe(true);

    const bad = runCampaignPreflight({
      subject: "Hello",
      fromName: "Ops",
      fromEmail: "news@contoso.com",
      htmlBody: '<p><a href="javascript:alert(1)">x</a></p>',
      textBody: "x",
      identity: loadSendingIdentity(),
    });
    expect(bad.ok).toBe(false);
  });

  it("allows SMTP campaign launches without attachments", () => {
    setIdentityEnv();
    const result = runCampaignPreflight({
      subject: "March update",
      fromName: "Ops",
      fromEmail: "news@contoso.com",
      htmlBody: '<p>Update <a href="https://www.contoso.com">site</a></p>',
      textBody: "Update https://www.contoso.com",
      identity: loadSendingIdentity(),
    });
    expect(result.ok).toBe(true);
  });
});

describe("monotonic status transitions", () => {
  it("rejects delivered -> submitted and preserves terminals", () => {
    expect(canTransitionMessageStatus("delivered", "submitted")).toBe(false);
    expect(canTransitionMessageStatus("bounced", "delivered")).toBe(false);
    expect(canTransitionMessageStatus("submitted", "delivered")).toBe(true);
    expect(canTransitionRecipientStatus("sent", "processing")).toBe(false);
    expect(canTransitionRecipientStatus("cancel_requested", "sent")).toBe(true);
    expect(canTransitionRecipientStatus("cancel_requested", "bounced")).toBe(true);
    expect(canTransitionRecipientStatus("cancelled", "sent")).toBe(false);
  });
});

describe("delivery health thresholds", () => {
  it("treats rate thresholds as optional display config under Spacemail SMTP", () => {
    delete process.env.SENDSTACK_HEALTH_MIN_SAMPLE;
    delete process.env.SENDSTACK_HEALTH_MAX_BOUNCE_RATE;
    delete process.env.SENDSTACK_HEALTH_MAX_COMPLAINT_RATE;
    delete process.env.SENDSTACK_HEALTH_MAX_UNSUBSCRIBE_RATE;
    delete process.env.SENDSTACK_HEALTH_MAX_DELAY_RATE;
    delete process.env.SENDSTACK_HEALTH_MAX_FAILURE_RATE;
    expect(loadDeliveryHealthThresholds().configured).toBe(true);
  });

  it("loads optional display thresholds when set", () => {
    process.env.SENDSTACK_HEALTH_MIN_SAMPLE = "10";
    process.env.SENDSTACK_HEALTH_MAX_BOUNCE_RATE = "0.05";
    process.env.SENDSTACK_HEALTH_MAX_COMPLAINT_RATE = "0.001";
    process.env.SENDSTACK_HEALTH_MAX_UNSUBSCRIBE_RATE = "0.02";
    process.env.SENDSTACK_HEALTH_MAX_DELAY_RATE = "0.2";
    process.env.SENDSTACK_HEALTH_MAX_FAILURE_RATE = "0.05";
    const thresholds = loadDeliveryHealthThresholds();
    expect(thresholds.configured).toBe(true);
    expect(thresholds.minSample).toBe(10);
  });
});

describe("launch chunking contract", () => {
  it("uses bounded chunks so a 10k audience is not one sequential request", () => {
    expect(DEFAULT_LAUNCH_CHUNK_SIZE).toBeLessThanOrEqual(5);
    const recipients = 10_000;
    const chunks = Math.ceil(recipients / DEFAULT_LAUNCH_CHUNK_SIZE);
    expect(chunks).toBe(2_000);
    expect(chunks * DEFAULT_LAUNCH_CHUNK_SIZE).toBeGreaterThanOrEqual(recipients);
  });
});
