import { describe, expect, it } from "vitest";

import { permissionForRequest } from "../auth/permissions.js";
import { ROLE_TEMPLATES } from "../auth/permissions.js";
import {
  assessDirectRecipients,
  assessSender,
  normalizeRecipientField,
  retryDecision,
} from "../mail/direct-send-policy.js";
import { assessDirectSendRateLimit, DIRECT_SEND_LIMITS } from "../mail/rate-limit.js";

const allow = ["allowed@example.com"];

describe("direct send recipients", () => {
  it("accepts a valid authorized address and drops repeats in one field", () => {
    const result = assessDirectRecipients({
      to: [" Allowed@Example.com ", "allowed@example.com"],
      cc: [],
      bcc: [],
      allowlist: allow,
      contactsByEmail: new Map(),
      suppressed: new Set(),
    });
    expect(result).toEqual({ ok: true, to: ["allowed@example.com"], cc: [], bcc: [] });
  });

  it("rejects invalid addresses", () => {
    const result = assessDirectRecipients({
      to: ["not-an-email"],
      cc: [],
      bcc: [],
      allowlist: allow,
      contactsByEmail: new Map(),
      suppressed: new Set(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects the same address in To and Bcc", () => {
    const result = assessDirectRecipients({
      to: ["allowed@example.com"],
      cc: [],
      bcc: ["allowed@example.com"],
      allowlist: allow,
      contactsByEmail: new Map(),
      suppressed: new Set(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/both To and Bcc/);
  });

  it("blocks suppressed, unsubscribed, and unknown-consent contacts", () => {
    const suppressed = assessDirectRecipients({
      to: ["allowed@example.com"],
      cc: [],
      bcc: [],
      allowlist: allow,
      contactsByEmail: new Map([["allowed@example.com", { subscriptionStatus: "subscribed" }]]),
      suppressed: new Set(["allowed@example.com"]),
    });
    expect(suppressed.ok).toBe(false);

    const unsubscribed = assessDirectRecipients({
      to: ["allowed@example.com"],
      cc: [],
      bcc: [],
      allowlist: allow,
      contactsByEmail: new Map([["allowed@example.com", { subscriptionStatus: "unsubscribed" }]]),
      suppressed: new Set(),
    });
    expect(unsubscribed.ok).toBe(false);

    const unknown = assessDirectRecipients({
      to: ["allowed@example.com"],
      cc: [],
      bcc: [],
      allowlist: allow,
      contactsByEmail: new Map([["allowed@example.com", { subscriptionStatus: "unknown" }]]),
      suppressed: new Set(),
    });
    expect(unknown.ok).toBe(false);
  });

  it("does not allow an address outside the test-recipient allowlist", () => {
    const result = assessDirectRecipients({
      to: ["other@example.com"],
      cc: [],
      bcc: [],
      allowlist: allow,
      contactsByEmail: new Map(),
      suppressed: new Set(),
    });
    expect(result.ok).toBe(false);
  });

  it("normalizes pasted lists", () => {
    expect(normalizeRecipientField(["one@example.com, two@example.com"]).accepted).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
  });
});

describe("direct send authorization and retries", () => {
  it("blocks a sender that is not the configured mailbox", () => {
    const result = assessSender("other@example.com", "info@ctn-sk.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.authorizedSender).toBe("info@ctn-sk.com");
  });

  it("maps composer send routes to mailbox.send and leaves test send separate", () => {
    expect(permissionForRequest("/api/mail/send", "POST")).toBe("mailbox.send");
    expect(permissionForRequest("/api/mail/sends", "GET")).toBe("mailbox.send");
    expect(permissionForRequest("/api/mail/test-send", "POST")).toBe("mailbox.send_test");
    expect(ROLE_TEMPLATES.admin.permissions).not.toContain("mailbox.send");
    expect(ROLE_TEMPLATES["super-admin"].permissions).toContain("mailbox.send");
  });

  it("does not resend after SMTP may have started", () => {
    expect(retryDecision("pending")).toBe("resume");
    expect(retryDecision("submitting")).toBe("uncertain");
    expect(retryDecision("accepted")).toBe("replay");
    expect(retryDecision("uncertain")).toBe("replay");
  });

  it("keeps the hourly cap small", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const attempts = Array.from({ length: DIRECT_SEND_LIMITS.maxPerHour }, () => ({
      createdAt: new Date(now.getTime() - 5 * 60_000),
    }));
    expect(assessDirectSendRateLimit(attempts, now).allowed).toBe(false);
    expect(assessDirectSendRateLimit([], now).allowed).toBe(true);
  });
});
