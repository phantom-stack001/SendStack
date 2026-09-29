import { describe, expect, it } from "vitest";
import { isPermanentBounce } from "../lib/providers/webhook-processor";

describe("bounce classification", () => {
  it("treats a permanent bounce as suppressible", () => {
    expect(
      isPermanentBounce({
        type: "email.bounced",
        data: { bounce: { type: "Permanent", subType: "General" } },
      }),
    ).toBe(true);
  });

  it("does not permanently suppress a transient bounce", () => {
    // A full mailbox must not destroy a legitimate subscriber: protected suppressions
    // cannot be cleared by re-consent or the removal APIs.
    expect(
      isPermanentBounce({
        type: "email.bounced",
        data: { bounce: { type: "Transient", subType: "MailboxFull" } },
      }),
    ).toBe(false);
    expect(
      isPermanentBounce({
        type: "email.bounced",
        data: { bounce: { type: "transient" } },
      }),
    ).toBe(false);
    expect(
      isPermanentBounce({
        type: "email.bounced",
        data: { bounce: { type: "Undetermined" } },
      }),
    ).toBe(false);
  });

  it("treats a missing classification as permanent to protect sending reputation", () => {
    expect(isPermanentBounce({ type: "email.bounced", data: {} })).toBe(true);
    expect(isPermanentBounce({ type: "email.bounced" })).toBe(true);
    expect(
      isPermanentBounce({ type: "email.bounced", data: { bounce: { type: "  " } } }),
    ).toBe(true);
  });
});
