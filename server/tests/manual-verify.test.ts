import { describe, expect, it } from "vitest";

import { permissionForRequest } from "../auth/permissions.js";
import { manualEmailVerificationSchema } from "../validation/admin-users.js";
import {
  applyManualEmailVerification,
  manualEmailVerificationAuditMetadata,
  manualVerifyActorError,
  verificationView,
} from "../services/manual-email-verification.js";

const historicalReason = "Verified ownership through an approved internal identity check.";

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

function request(overrides: Partial<{ userId: string; expectedEmail: string; confirmed: boolean }> = {}) {
  return {
    userId: "user_1",
    expectedEmail: "person@example.com",
    confirmed: true,
    ...overrides,
  };
}

describe("manual email verification", () => {
  it("requires confirmation and the reviewed email, and does not require a reason", () => {
    expect(manualEmailVerificationSchema.safeParse({ confirmed: true, expectedEmail: "person@example.com" }).success).toBe(true);
    expect(manualEmailVerificationSchema.safeParse({ expectedEmail: "person@example.com" }).success).toBe(false);
    expect(manualEmailVerificationSchema.safeParse({ confirmed: false, expectedEmail: "person@example.com" }).success).toBe(false);
    expect(manualEmailVerificationSchema.safeParse({ confirmed: true, expectedEmail: "not-an-email" }).success).toBe(false);
    expect(manualEmailVerificationSchema.safeParse({ confirmed: true }).success).toBe(false);

    const withIgnoredReason = manualEmailVerificationSchema.safeParse({
      confirmed: true,
      expectedEmail: "person@example.com",
      reason: "This text is no longer required.",
    });
    expect(withIgnoredReason.success).toBe(true);
    if (withIgnoredReason.success) {
      expect(withIgnoredReason.data).toEqual({
        confirmed: true,
        expectedEmail: "person@example.com",
      });
    }
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

  it("verifies only the reviewed address and records one audit event without a reason", async () => {
    const account = target();
    const audits: { actorUserId: string; targetUserId: string; email: string }[] = [];
    const result = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: request({ userId: account.id, expectedEmail: account.email }),
      loadTarget: async () => account,
      markVerified: async (_userId, email) => {
        if (account.email !== email || account.emailVerified) return false;
        account.emailVerified = true;
        return true;
      },
      writeAudit: async (event) => {
        audits.push(event);
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.email).toBe("person@example.com");
      expect(result.user.emailVerified).toBe(true);
      expect(result.user.role).toBe("user");
      expect(result.user.banned).toBe(false);
      expect(result.user.status).toBe("active");
    }
    expect(audits).toEqual([{ actorUserId: "admin_1", targetUserId: "user_1", email: "person@example.com" }]);
    expect(manualEmailVerificationAuditMetadata("person@example.com")).toEqual({
      email: "person@example.com",
      verificationMethod: "manual",
    });
    expect(manualEmailVerificationAuditMetadata("person@example.com")).not.toHaveProperty("reason");
  });

  it("rejects admin and ordinary actors before any update", async () => {
    for (const role of ["admin", "user"]) {
      let updates = 0;
      const result = await applyManualEmailVerification({
        actor: { id: "actor_1", role },
        request: request(),
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
    }
  });

  it("rejects a missing confirmation before any update", async () => {
    let updates = 0;
    const result = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: request({ confirmed: false }),
      loadTarget: async () => target(),
      markVerified: async () => {
        updates += 1;
        return true;
      },
      writeAudit: async () => undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(updates).toBe(0);
  });

  it("rejects a stale email and an unknown user without an audit event", async () => {
    const audits: string[] = [];
    const changed = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: request({ expectedEmail: "old@example.com" }),
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
      request: request({ userId: "missing" }),
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
    const account = target({ emailVerified: true, status: "suspended", banned: true, role: "editor" });
    const audits: string[] = [];
    let updates = 0;
    const result = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: request(),
      loadTarget: async () => account,
      markVerified: async () => {
        updates += 1;
        return false;
      },
      writeAudit: async () => {
        audits.push("audit");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already verified/i);
    expect(updates).toBe(0);
    expect(audits).toEqual([]);
    expect(account.emailVerified).toBe(true);
    expect(account.role).toBe("editor");
    expect(account.status).toBe("suspended");
    expect(account.banned).toBe(true);
  });

  it("keeps a suspended account suspended when the email becomes verified", async () => {
    const account = target({ status: "suspended", banned: true });
    const result = await applyManualEmailVerification({
      actor: { id: "admin_1", role: "super-admin" },
      request: request({ userId: account.id, expectedEmail: account.email }),
      loadTarget: async () => account,
      markVerified: async () => {
        account.emailVerified = true;
        return true;
      },
      writeAudit: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.emailVerified).toBe(true);
      expect(result.user.status).toBe("suspended");
      expect(result.user.banned).toBe(true);
      expect(result.user.role).toBe("user");
      expect(result.user.email).toBe(account.email);
    }
  });

  it("shows manual metadata only when it matches the current address", () => {
    const recorded = verificationView({
      emailVerified: true,
      email: "person@example.com",
      manualEvent: {
        createdAt: new Date("2026-10-10T12:00:00Z"),
        metadata: { email: "person@example.com", reason: historicalReason, verificationMethod: "manual" },
      },
    });
    expect(recorded.method).toBe("manual");
    expect(recorded.reason).toBe(historicalReason);
    expect(recorded.verifiedAt).toBe("2026-10-10T12:00:00.000Z");

    const withoutReason = verificationView({
      emailVerified: true,
      email: "person@example.com",
      manualEvent: {
        createdAt: new Date("2026-10-10T12:05:00Z"),
        metadata: manualEmailVerificationAuditMetadata("person@example.com"),
      },
    });
    expect(withoutReason.method).toBe("manual");
    expect(withoutReason.reason).toBeNull();

    const unknown = verificationView({
      emailVerified: true,
      email: "person@example.com",
      manualEvent: null,
    });
    expect(unknown.method).toBe("unknown");
    expect(unknown.verifiedAt).toBeNull();
    expect(unknown.reason).toBeNull();

    const unverified = verificationView({
      emailVerified: false,
      email: "person@example.com",
      manualEvent: {
        createdAt: new Date("2026-10-10T12:00:00Z"),
        metadata: { email: "person@example.com", reason: historicalReason, verificationMethod: "manual" },
      },
    });
    expect(unverified.status).toBe("unverified");
    expect(unverified.method).toBeNull();
    expect(unverified.reason).toBeNull();
  });
});
