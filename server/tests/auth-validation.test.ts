import { describe, expect, it } from "vitest";

import { mapAuthErrorMessage } from "../../src/lib/auth-validation.js";

describe("mapAuthErrorMessage", () => {
  it("shows Better Auth's rejected sign-in response as invalid credentials", () => {
    expect(mapAuthErrorMessage("Invalid email or password")).toBe("Invalid email or password.");
    expect(mapAuthErrorMessage("INVALID_EMAIL_OR_PASSWORD")).toBe("Invalid email or password.");
  });

  it("keeps the verification guidance for unverified accounts", () => {
    expect(mapAuthErrorMessage("Email not verified")).toBe(
      "Verify your email before signing in. Check your inbox for a verification link.",
    );
  });

  it("hides unexpected failures behind the generic message", () => {
    expect(mapAuthErrorMessage("Internal server error")).toBe(
      "Unable to complete the request. Please try again.",
    );
  });
});
