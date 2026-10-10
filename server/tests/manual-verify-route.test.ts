import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionUser, manuallyVerifyUserEmail, getAdminUser } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  manuallyVerifyUserEmail: vi.fn(),
  getAdminUser: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  createDb: () => ({ db: { transaction: vi.fn() }, client: { end: vi.fn() } }),
}));

vi.mock("../lib/session.js", () => ({
  getSessionUser: (...args: unknown[]) => getSessionUser(...args),
}));

vi.mock("../services/manual-email-verification.js", () => ({
  manuallyVerifyUserEmail: (...args: unknown[]) => manuallyVerifyUserEmail(...args),
  latestManualVerification: vi.fn(),
  verificationView: vi.fn(),
  MANUAL_EMAIL_VERIFICATION_ACTION: "user.email_verified_manually",
}));

vi.mock("../services/admin.js", () => ({
  acceptInvitation: vi.fn(),
  createDirectUser: vi.fn(),
  createInvitation: vi.fn(),
  deactivateOrDeleteUser: vi.fn(),
  deleteRole: vi.fn(),
  getAdminUser: (...args: unknown[]) => getAdminUser(...args),
  getRole: vi.fn(),
  listAdminUsers: vi.fn(),
  listAudit: vi.fn(),
  listInvitations: vi.fn(),
  listPermissionCatalog: vi.fn(),
  listRoles: vi.fn(),
  requestUserPasswordReset: vi.fn(),
  revokeInvitation: vi.fn(),
  revokeUserSessions: vi.fn(),
  saveRole: vi.fn(),
  setUserStatus: vi.fn(),
  updateAdminUser: vi.fn(),
}));

import { registerAdminRoutes } from "../routes/admin.js";

function app() {
  const instance = new Hono();
  registerAdminRoutes(instance);
  return instance;
}

function post(body: unknown) {
  return app().request("http://localhost/api/admin/users/user_1/verify-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/users/:userId/verify-email", () => {
  beforeEach(() => {
    getSessionUser.mockReset();
    manuallyVerifyUserEmail.mockReset();
    getAdminUser.mockReset();
  });

  it("returns 401 when the request has no session", async () => {
    getSessionUser.mockResolvedValue(null);
    const response = await post({ confirmed: true, expectedEmail: "person@example.com" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(manuallyVerifyUserEmail).not.toHaveBeenCalled();
  });

  it("rejects a body that omits confirmation before any verification", async () => {
    getSessionUser.mockResolvedValue({ id: "admin_1", role: "super-admin", banned: false });
    const response = await post({ expectedEmail: "person@example.com", reason: "No longer required." });
    expect(response.status).toBe(400);
    expect(manuallyVerifyUserEmail).not.toHaveBeenCalled();
  });

  it("verifies with confirmation and the reviewed email, and ignores a reason", async () => {
    getSessionUser.mockResolvedValue({ id: "admin_1", role: "super-admin", banned: false });
    manuallyVerifyUserEmail.mockResolvedValue({
      ok: true,
      user: { id: "user_1", email: "person@example.com", emailVerified: true, role: "user", banned: false, status: "active" },
    });
    getAdminUser.mockResolvedValue({
      id: "user_1",
      name: "Ada",
      email: "person@example.com",
      emailVerified: true,
      roles: ["user"],
      status: "active",
    });

    const response = await post({
      confirmed: true,
      expectedEmail: "person@example.com",
      reason: "This must not be forwarded.",
    });
    expect(response.status).toBe(200);
    expect(manuallyVerifyUserEmail).toHaveBeenCalledWith(
      expect.anything(),
      { id: "admin_1", role: "super-admin", banned: false },
      { userId: "user_1", confirmed: true, expectedEmail: "person@example.com" },
    );
    const payload = (await response.json()) as { user: { emailVerified: boolean } };
    expect(payload.user.emailVerified).toBe(true);
  });

  it("forwards a super-admin rejection without verifying", async () => {
    getSessionUser.mockResolvedValue({ id: "admin_1", role: "admin", banned: false });
    manuallyVerifyUserEmail.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Only a super admin can verify an email address manually.",
    });
    const response = await post({ confirmed: true, expectedEmail: "person@example.com" });
    expect(response.status).toBe(403);
    expect(getAdminUser).not.toHaveBeenCalled();
  });
});
