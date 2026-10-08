import { describe, expect, it } from "vitest";
import { isPermanentBounce } from "../lib/providers/webhook-processor";

describe("bounce classification", () => {
  it("treats missing bounce type as permanent", () => {
    expect(isPermanentBounce({})).toBe(true);
    expect(isPermanentBounce({ data: { bounce: { type: "Permanent" } } })).toBe(true);
  });

  it("treats soft/transient bounces as non-permanent", () => {
    expect(isPermanentBounce({ data: { bounce: { type: "Transient" } } })).toBe(false);
    expect(isPermanentBounce({ data: { bounce: { type: "soft" } } })).toBe(false);
    expect(isPermanentBounce({ data: { bounce: { type: "Undetermined" } } })).toBe(false);
  });
});
