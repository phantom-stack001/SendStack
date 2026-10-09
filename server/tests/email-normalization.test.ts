import { describe, expect, it } from "vitest";

import { isValidEmail, normalizeEmail } from "../lib/email-normalization.js";

describe("email normalization", () => {
  it("normalizes casing and whitespace", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("validates email format", () => {
    expect(isValidEmail("valid@example.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });
});
