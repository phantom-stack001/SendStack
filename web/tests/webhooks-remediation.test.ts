import { describe, expect, it } from "vitest";
import { isPermanentBounce } from "../lib/providers/webhook-processor";

/**
 * Spacemail SMTP has no delivery webhooks. These tests keep bounce-classification
 * helpers for historical rows and any remaining API-side event handling.
 */
describe("smtp-era bounce helpers", () => {
  it("keeps permanent-bounce fail-closed behavior", () => {
    expect(isPermanentBounce({ data: {} })).toBe(true);
    expect(isPermanentBounce({ data: { bounce: { type: "Permanent" } } })).toBe(true);
  });
});
