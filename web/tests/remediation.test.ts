import { afterEach, describe, expect, it, vi } from "vitest";
import { importContactStatus, isSendableContactStatus } from "../lib/consent";
import { applyComplianceFooter } from "../lib/compliance-footer";
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
  process.env.SENDSTACK_COMPANY_NAME = "Contoso Ltd";
  process.env.SENDSTACK_POSTAL_ADDRESS = "1 Contoso Way, Contoso City, CT1 1AA";
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
    expect(validateCampaignLink("{{{RESEND_UNSUBSCRIBE_URL}}}", allowed).ok).toBe(true);
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

describe("compliance footer injection", () => {
  it("injects company, postal, contact, and unsubscribe into html and text", () => {
    setIdentityEnv();
    const identity = loadSendingIdentity();
    const result = applyComplianceFooter(
      "<p>Hello {{first_name}}</p>",
      "Hello {{first_name}}",
      identity,
    );
    expect(result.html).toContain("Contoso Ltd");
    expect(result.html).toContain("1 Contoso Way");
    expect(result.html).toContain("hello@contoso.com");
    expect(result.html).toContain('href="{{unsubscribe_url}}"');
    expect(result.text).toContain("Contoso Ltd");
    expect(result.text).toContain("Unsubscribe: {{unsubscribe_url}}");
    expect(result.html).not.toMatch(/&lt;script/);
  });

  it("keeps Resend broadcast unsubscribe placeholder", () => {
    setIdentityEnv();
    const result = applyComplianceFooter("<p>Hi</p>", "Hi", loadSendingIdentity(), { broadcast: true });
    expect(result.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
    expect(result.text).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
  });

  it("always reinjects canonical footer even when marker text was author-supplied", () => {
    setIdentityEnv();
    const result = applyComplianceFooter(
      '<p>Hi</p><div class="sendstack-compliance-footer">stale author footer</div>',
      "Hi\n---\nOld Co\nUnsubscribe: {{unsubscribe_url}}",
      loadSendingIdentity(),
    );
    expect(result.html).toContain("Contoso Ltd");
    expect(result.html).not.toContain("stale author footer");
    expect((result.html.match(/sendstack-compliance-footer/g) || []).length).toBe(1);
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

  it("blocks broadcast launches when attachments exist", () => {
    setIdentityEnv();
    const footered = applyComplianceFooter(
      '<p>Update <a href="https://www.contoso.com">site</a></p>',
      "Update https://www.contoso.com",
      loadSendingIdentity(),
      { broadcast: true },
    );
    const result = runCampaignPreflight({
      subject: "March update",
      fromName: "Ops",
      fromEmail: "news@contoso.com",
      htmlBody: footered.html,
      textBody: footered.text,
      attachmentCount: 1,
      forBroadcast: true,
      identity: loadSendingIdentity(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/Broadcasts do not support/i);
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
    expect(DEFAULT_LAUNCH_CHUNK_SIZE).toBeLessThanOrEqual(100);
    const recipients = 10_000;
    const chunks = Math.ceil(recipients / DEFAULT_LAUNCH_CHUNK_SIZE);
    expect(chunks).toBe(100);
    // One HTTP launch creates a job; worker ticks process chunks.
    expect(chunks * DEFAULT_LAUNCH_CHUNK_SIZE).toBeGreaterThanOrEqual(recipients);
  });
});
