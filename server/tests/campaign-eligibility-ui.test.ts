import { describe, expect, it } from "vitest";

import {
  exclusionCategoryRows,
  recipientDisplayStatus,
  wizardStepForIssueCode,
} from "../../src/lib/campaign-eligibility-ui.js";

describe("campaign eligibility UI helpers", () => {
  it("maps subscription and suppression to display status", () => {
    expect(recipientDisplayStatus("subscribed", false)).toBe("subscribed");
    expect(recipientDisplayStatus("subscribed", true)).toBe("suppressed");
    expect(recipientDisplayStatus("pending", false)).toBe("pending");
  });

  it("builds exclusion category rows without double-counting totals", () => {
    const rows = exclusionCategoryRows({
      selectedRaw: 3,
      uniqueEmails: 3,
      duplicates: 0,
      eligible: 1,
      excludedUnsubscribed: 1,
      excludedSuppressed: 0,
      excludedPendingConsent: 1,
      excludedUnknownConsent: 0,
      excludedInvalid: 0,
      excludedTotal: 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum: number, row: { count: number }) => sum + row.count, 0)).toBe(2);
  });

  it("routes wizard issues to the correct step", () => {
    expect(wizardStepForIssueCode("NO_ELIGIBLE_RECIPIENTS")).toBe(2);
    expect(wizardStepForIssueCode("SENDER_EMAIL_INVALID")).toBe(1);
    expect(wizardStepForIssueCode("NAME_REQUIRED")).toBe(0);
  });
});
