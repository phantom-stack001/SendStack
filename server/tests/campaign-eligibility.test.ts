import { describe, expect, it } from "vitest";

import {
  buildEligibilitySnapshot,
  classifyContactEligibility,
  dedupeContactCandidates,
} from "../services/campaign-eligibility.js";

describe("campaign eligibility", () => {
  it("deduplicates by normalized email deterministically", () => {
    const { unique, duplicates, selectedRaw } = dedupeContactCandidates([
      { contactId: "b", email: "User@Example.com", subscriptionStatus: "subscribed" },
      { contactId: "a", email: "user@example.com", subscriptionStatus: "subscribed" },
    ]);
    expect(selectedRaw).toBe(2);
    expect(duplicates).toBe(1);
    expect(unique).toHaveLength(1);
    expect(unique[0]?.contactId).toBe("a");
  });

  it("excludes unsubscribed, unknown, and suppressed contacts", () => {
    const suppressed = new Set(["blocked@example.com"]);
    expect(
      classifyContactEligibility(
        { contactId: "1", email: "blocked@example.com", subscriptionStatus: "subscribed" },
        suppressed,
      ).eligibilityStatus,
    ).toBe("excluded_suppressed");
    expect(
      classifyContactEligibility(
        { contactId: "2", email: "gone@example.com", subscriptionStatus: "unsubscribed" },
        suppressed,
      ).eligibilityStatus,
    ).toBe("excluded_unsubscribed");
    expect(
      classifyContactEligibility(
        { contactId: "3", email: "maybe@example.com", subscriptionStatus: "unknown" },
        suppressed,
      ).eligibilityStatus,
    ).toBe("excluded_unknown_consent");
    expect(
      classifyContactEligibility(
        { contactId: "5", email: "wait@example.com", subscriptionStatus: "pending" },
        suppressed,
      ).eligibilityStatus,
    ).toBe("excluded_pending_consent");
    expect(
      classifyContactEligibility(
        { contactId: "4", email: "ok@example.com", subscriptionStatus: "subscribed" },
        suppressed,
      ).eligibilityStatus,
    ).toBe("eligible");
  });

  it("builds consistent exclusion totals", () => {
    const { summary } = buildEligibilitySnapshot(
      [
        { contactId: "1", email: "a@example.com", subscriptionStatus: "subscribed" },
        { contactId: "2", email: "b@example.com", subscriptionStatus: "unsubscribed" },
        { contactId: "3", email: "a@example.com", subscriptionStatus: "subscribed" },
      ],
      new Set(),
    );
    expect(summary.selectedRaw).toBe(3);
    expect(summary.duplicates).toBe(1);
    expect(summary.eligible).toBe(1);
    expect(summary.excludedUnsubscribed).toBe(1);
    expect(summary.excludedTotal).toBe(1);
  });
});
