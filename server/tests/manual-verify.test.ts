import { describe, expect, it } from "vitest";

import { permissionForRequest } from "../auth/permissions.js";
import { manualEmailVerificationSchema } from "../validation/admin-users.js";
import {
  applyManualEmailVerification,
  manualVerifyActorError,
  verificationView,
} from "../services/manual-email-verification.js";

const reason = "Verified ownership through an approved internal identity check.";

function target(overrides: Partial<{
  id: string;
  email: string;
  emailVerified: boolean;
  role: string | null;
  banned: boolean | null;
  status: string;
}> = {}) {
  return {
    id: "user_1",
    email: "person@example.com",
    emailVerified: false,
    role: "user",
    banned: false,
    status: "active",
    ...overrides,
  };
}

describe("manual email verification", () => {
  it("requires confirmation, a reason, and the reviewed email", () => {
    expect(manualEmailVerificationSchema.safeParse({ confirmed: true, reason: "Too short", expectedEmail: "person@example.com" }).success).toBe(false);
    expect(manualEmailVerificationSchema.safeParse({ confirmed: false, reason: "Verified ownership through an approved internal identity check.", expectedEmail: "person@example.com" }).success).toBe(false);
    expect(manualEmailVerificationSchema.safeParse({ reason: "Verified ownership through an approved internal identity check.", expectedEmail: "person@example.com" }).success).toBe(false);
    expect(manualEmailVerificationSchema.safeParse({
      confirmed: true,
      reason: "Verified ownership through an approved internal identity check.",
      expectedEmail: "not-an-email",
    }).success).toBe(false);
    expect(manualEmailVerificationSchema.safeParse({
      confirmed: true,
      reason: "Verified ownership through an approved internal identity check.",
      expectedEmail: "person@example.com",
    }).success).toBe(true);
  });

  it("allows only an active super admin", () => {
    expect(manualVerifyActorError({ id: "a", role: "super-admin" })).toBeNull();
    expect(manualVerifyActorError({ id: "a", role: "admin" })).toMatch(/super admin/i);
    expect(manualVerifyActorError({ id: "a", role: "user" })).toMatch(/super admin/i);
    expect(manualVerifyActorError({ id: "a", role: "super-admin,admin", banned: true })).toMatch(/cannot verify/i);
    expect(manualVerifyActorError({ id: "a", role: "super-admin" }, "suspended")).toMatch(/cannot verify/i);
    expect(manualVerifyActorError({ id: "a", role: "super-admin" }, "deactivated")).toMatch(/cannot verify/i);
  });

  it("does not map manual verification to users.update", () => {
    expect(permissionForRequest("/api/admin/users/user_1/verify-email", "POST")).toBeNull();
    expect(permissionForRequest("/api/admin/users/user_1", "PATCH")).toBe("users.update");
  });

  it("verifies only the reviewed address and records one audit event", async () => {
    const account = target();
    const audits: { email: string; reason: string }[] = [];
    const result = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: { userId: account.id, expectedEmail: account.email, reason, confirmed: true },
      loadTarget: async () => account,
      markVerified: async (_userId, email) => {
        if (account.email !== email || account.emailVerified) return false;
        account.emailVerified = true;
        return true;
      },
      writeAudit: async (event) => {
        audits.push({ email: event.email, reason: event.reason });
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.emailVerified).toBe(true);
      expect(result.user.role).toBe("user");
      expect(result.user.banned).toBe(false);
      expect(result.user.status).toBe("active");
    }
    expect(audits).toEqual([{ email: "person@example.com", reason }]);
  });

  it("rejects admin and ordinary actors before any update", async () => {
    let updates = 0;
    const result = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "admin" },
      request: { userId: "user_1", expectedEmail: "person@example.com", reason, confirmed: true },
      loadTarget: async () => target(),
      markVerified: async () => {
        updates += 1;
        return true;
      },
      writeAudit: async () => undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(updates).toBe(0);
  });

  it("rejects a stale email and an unknown user without an audit event", async () => {
    const audits: string[] = [];
    const changed = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: { userId: "user_1", expectedEmail: "old@example.com", reason, confirmed: true },
      loadTarget: async () => target({ email: "new@example.com" }),
      markVerified: async () => true,
      writeAudit: async () => {
        audits.push("audit");
      },
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.status).toBe(409);

    const missing = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: { userId: "missing", expectedEmail: "person@example.com", reason, confirmed: true },
      loadTarget: async () => null,
      markVerified: async () => true,
      writeAudit: async () => {
        audits.push("audit");
      },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
    expect(audits).toEqual([]);
  });

  it("does not write another audit event when verification already completed", async () => {
    const audits: string[] = [];
    const result = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: { userId: "user_1", expectedEmail: "person@example.com", reason, confirmed: true },
      loadTarget: async () => target({ emailVerified: true, status: "suspended", banned: true }),
      markVerified: async () => false,
      writeAudit: async () => {
        audits.push("audit");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already verified/i);
    expect(audits).toEqual([]);
  });

  it("keeps a suspended account suspended when the email becomes verified", async () => {
    const account = target({ status: "suspended", banned: true });
    const result = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: { userId: account.id, expectedEmail: account.email, reason, confirmed: true },
      loadTarget: async () => account,
      markVerified: async () => {
        account.emailVerified = true;
        return true;
      },
      writeAudit: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.status).toBe("suspended");
      expect(result.user.banned).toBe(true);
      expect(result.user.role).toBe("user");
    }
  });

  it("shows manual metadata only when it matches the current address", () => {
    const recorded = verificationView({
      emailVerified: true,
      email: "person@example.com",
      manualEvent: {
        createdAt: new Date("2026-10-10T12:00:00Z"),
        metadata: { email: "person@example.com", reason, verificationMethod: "manual" },
      },
    });
    expect(recorded.method).toBe("manual");
    expect(recorded.verifiedAt).toBe("2026-10-10T12:00:00.000Z");

    const unknown = verificationView({
      emailVerified: true,
      email: "person@example.com",
      manualEvent: null,
    });
    expect(unknown.method).toBe("unknown");
    expect(unknown.verifiedAt).toBeNull();

    const unverified = verificationView({
      emailVerified: false,
      email: "person@example.com",
      manualEvent: null,
    });
    expect(unverified.status).toBe("unverified");
    expect(unverified.method).toBeNull();
  });
});
