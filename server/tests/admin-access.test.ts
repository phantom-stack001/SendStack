import { describe, expect, it } from "vitest";

import { permissionForRequest, PERMISSIONS } from "../auth/permissions.js";
import { createHash } from "node:crypto";
import {
  customRoleKeyError,
  invalidPermissionKeys,
  roleGrantError,
  superAdminRemovalAllowed,
} from "../auth/policy.js";
import { queueEnvSchema } from "../queue/configuration.js";

describe("admin authorization", () => {
  it("rejects removing the last active super admin", () => {
    expect(superAdminRemovalAllowed({
      activeSuperAdmins: 1,
      targetIsActiveSuperAdmin: true,
      nextIncludesSuperAdmin: false,
    })).toBe(false);
    expect(superAdminRemovalAllowed({
      activeSuperAdmins: 2,
      targetIsActiveSuperAdmin: true,
      nextIncludesSuperAdmin: false,
    })).toBe(true);
  });

  it("blocks privilege escalation and self-promotion to super-admin", () => {
    const error = roleGrantError({
      actorIsSuperAdmin: false,
      actorPermissions: new Set(["campaigns.read"]),
      nextRoleKeys: ["editor"],
      rolePermissions: { editor: ["drafts.update", "campaigns.read"] },
      actorId: "actor",
      targetId: "target",
      activeSuperAdmins: 1,
      targetIsActiveSuperAdmin: false,
    });
    expect(error).toMatch(/permissions you do not have/);
    expect(roleGrantError({
      actorIsSuperAdmin: false,
      actorPermissions: new Set(PERMISSIONS),
      nextRoleKeys: ["super-admin"],
      rolePermissions: { "super-admin": PERMISSIONS },
      actorId: "actor",
      targetId: "target",
      activeSuperAdmins: 1,
      targetIsActiveSuperAdmin: false,
    })).toMatch(/Only a super admin/);
  });

  it("protects reserved role keys and unknown permissions", () => {
    expect(customRoleKeyError("super-admin")).toMatch(/reserved/);
    expect(customRoleKeyError("billing-admin")).toBeNull();
    expect(invalidPermissionKeys(["campaigns.read", "nope.permission"])).toEqual(["nope.permission"]);
  });

  it("maps mailbox and user routes to permissions", () => {
    expect(permissionForRequest("/api/mail/inbox", "GET")).toBe("mailbox.read");
    expect(permissionForRequest("/api/mail/test-send", "POST")).toBe("mailbox.send_test");
    expect(permissionForRequest("/api/admin/users", "GET")).toBe("users.read");
    expect(permissionForRequest("/api/admin/audit", "GET")).toBe("audit.read");
    expect(permissionForRequest("/api/drafts", "GET")).toBe("drafts.read");
  });

  it("stores only a hash of an invitation token", () => {
    const token = "invite-token-value";
    const hash = createHash("sha256").update(token).digest("hex");
    expect(hash).not.toBe(token);
    expect(hash).toHaveLength(64);
  });

  it("keeps the campaign queue simulation-only", () => {
    expect(queueEnvSchema.safeParse({
      QUEUE_ENABLED: "true",
      QUEUE_SIMULATION_ONLY: "false",
      REDIS_URL: "redis://127.0.0.1:6379",
    }).success).toBe(false);
  });
});
