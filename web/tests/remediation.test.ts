import { afterEach, describe, expect, it, vi } from "vitest";
import { importContactStatus, isSendableContactStatus } from "../lib/consent";
import { applyComplianceFooter } from "../lib/compliance-footer";
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
    expect(validateAllowedLinkDomains(["co.kr"]).length).toBeGreaterThan(0);
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

describe("compliance footer pass-through", () => {
  it("returns authored html and text unchanged", () => {
    setIdentityEnv();
    const identity = loadSendingIdentity();
    const html = '<p>Hello {{first_name}}</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>';
    const text = "Hello {{first_name}}\nUnsubscribe: {{unsubscribe_url}}";
    const result = applyComplianceFooter(html, text, identity);
    expect(result.html).toBe(html);
    expect(result.text).toBe(text);
    expect(result.html).not.toContain("Contoso Ltd");
    expect(result.html).not.toContain("1 Contoso Way");
  });

  it("does not inject unsubscribe tokens when the author omitted them", () => {
    setIdentityEnv();
    const result = applyComplianceFooter("<p>Hi</p>", "Hi", loadSendingIdentity(), { broadcast: true });
    expect(result.html).toBe("<p>Hi</p>");
    expect(result.text).toBe("Hi");
    expect(result.html).not.toContain("{{unsubscribe_url}}");
  });

  it("preserves author content including dashes and Unsubscribe lines", () => {
    setIdentityEnv();
    const html = "<p>Hi</p><p>Section --- still here</p>";
    const text = "Hi\n---\nOld Co\nUnsubscribe: read this line";
    const result = applyComplianceFooter(html, text, loadSendingIdentity());
    expect(result.html).toBe(html);
    expect(result.text).toBe(text);
    const again = applyComplianceFooter(result.html, result.text, loadSendingIdentity());
    expect(again.html).toBe(result.html);
    expect(again.text).toBe(result.text);
  });

  it("does not strip author CSS", () => {
    setIdentityEnv();
    const identity = loadSendingIdentity();
    const hidden = applyComplianceFooter('<p style="display:none;color:#333">Hi</p>', "Hi", identity);
    expect(hidden.html).toBe('<p style="display:none;color:#333">Hi</p>');
    const styled = applyComplianceFooter("<style>p{color:#333}</style><p>Hi</p>", "Hi", identity);
    expect(styled.html).toContain("<style");
    expect(styled.html).toBe("<style>p{color:#333}</style><p>Hi</p>");
  });

  it("preserves visual layout styles", () => {
    setIdentityEnv();
    const html =
      '<div style="max-height:0;line-height:1px;font-size:1px;color:#ffffff">Preview</div>' +
      '<table style="max-width:600px;background:#ffffff;border-radius:14px"><tr><td style="padding:34px 30px;color:#14213d">Hello</td></tr></table>';
    const result = applyComplianceFooter(html, "Hello", loadSendingIdentity());
    expect(result.html).toBe(html);
    expect(result.html).toContain("border-radius:14px");
    expect(result.html).toContain("max-height:0");
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
  it("rejects fake forwards, placeholders, archives, and bad links after footer", () => {
    setIdentityEnv();
    const footered = applyComplianceFooter(
      '<p>Replace this text <a href="https://evil.example">x</a></p>',
      "Replace this text",
      loadSendingIdentity(),
    );
    const result = runCampaignPreflight({
      subject: "FW: invoice",
      fromName: "Ops",
      fromEmail: "news@contoso.com",
      htmlBody: footered.html,
      textBody: footered.text,
      attachmentExtensions: ["zip"],
      identity: loadSendingIdentity(),
      requirePublicHttps: true,
    });
    expect(result.ok).toBe(false);
  });

  it("allows SMTP campaign launches with non-archive attachments", () => {
    setIdentityEnv();
    const footered = applyComplianceFooter(
      '<p>Update <a href="https://www.contoso.com">site</a></p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
      "Update https://www.contoso.com\nUnsubscribe: {{unsubscribe_url}}",
      loadSendingIdentity(),
    );
    const result = runCampaignPreflight({
      subject: "March update",
      fromName: "Ops",
      fromEmail: "news@contoso.com",
      htmlBody: footered.html,
      textBody: footered.text,
      attachmentCount: 1,
      attachmentExtensions: ["pdf"],
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
  it("requires explicit threshold configuration", () => {
    delete process.env.SENDSTACK_HEALTH_MIN_SAMPLE;
    delete process.env.SENDSTACK_HEALTH_MAX_BOUNCE_RATE;
    delete process.env.SENDSTACK_HEALTH_MAX_COMPLAINT_RATE;
    delete process.env.SENDSTACK_HEALTH_MAX_UNSUBSCRIBE_RATE;
    delete process.env.SENDSTACK_HEALTH_MAX_DELAY_RATE;
    delete process.env.SENDSTACK_HEALTH_MAX_FAILURE_RATE;
    expect(loadDeliveryHealthThresholds().configured).toBe(false);
  });

  it("loads configured thresholds", () => {
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
    // One HTTP launch creates a job; worker ticks process chunks.
    expect(chunks * DEFAULT_LAUNCH_CHUNK_SIZE).toBeGreaterThanOrEqual(recipients);
  });
});
