import type { Context, Hono } from "hono";
import { z } from "zod";

import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { validationError } from "../lib/http-errors.js";
import { createUserSchema, manualEmailVerificationSchema } from "../validation/admin-users.js";
import { getSessionUser } from "../lib/session.js";
import { manuallyVerifyUserEmail } from "../services/manual-email-verification.js";
import type { PermissionKey } from "../auth/permissions.js";
import { userHasPermission } from "../services/access-control.js";
import { permissionsForUser } from "../services/access-control.js";
import {
  acceptInvitation,
  createDirectUser,
  createInvitation,
  deactivateOrDeleteUser,
  deleteRole,
  getAdminUser,
  getRole,
  listAdminUsers,
  listAudit,
  listInvitations,
  listPermissionCatalog,
  listRoles,
  requestUserPasswordReset,
  revokeInvitation,
  revokeUserSessions,
  saveRole,
  setUserStatus,
  updateAdminUser,
} from "../services/admin.js";

const env = loadEnv();
const { db } = createDb(env);

const inviteSchema = z.object({
  email: z.email(),
  roleKeys: z.array(z.string().min(1)).min(1).max(5),
});

const userUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roleKeys: z.array(z.string().min(1)).min(1).max(5).optional(),
});

const statusSchema = z.object({
  status: z.enum(["active", "suspended", "deactivated"]),
});

const roleSchema = z.object({
  key: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).default(""),
  permissions: z.array(z.string()).max(80).default([]),
});

function json(c: Context, body: unknown, status: 200 | 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 = 200) {
  c.header("Cache-Control", "no-store");
  return c.json(body, status);
}

async function requirePermission(c: Context, permission: PermissionKey) {
  const account = await getSessionUser(c.req.raw.headers);
  if (!account) return { response: json(c, { error: "Unauthorized" }, 401) };
  if ((account as { banned?: boolean }).banned) {
    return { response: json(c, { error: "This account cannot access SendStack." }, 403) };
  }
  const allowed = await userHasPermission(db, account, permission);
  if (!allowed) return { response: json(c, { error: "You do not have permission to do that." }, 403) };
  return { user: account };
}

export function registerAdminRoutes(app: Hono) {
  app.get("/api/admin/permissions", async (c) => {
    const access = await requirePermission(c, "permissions.read");
    if ("response" in access) return access.response;
    return json(c, { permissions: listPermissionCatalog() });
  });

  app.get("/api/admin/users", async (c) => {
    const access = await requirePermission(c, "users.read");
    if ("response" in access) return access.response;
    const page = Number(c.req.query("page") ?? "1");
    const limit = Number(c.req.query("limit") ?? "25");
    const result = await listAdminUsers(db, {
      search: c.req.query("search") ?? undefined,
      role: c.req.query("role") ?? undefined,
      status: c.req.query("status") ?? undefined,
      verification: c.req.query("verification") ?? undefined,
      page: Number.isFinite(page) && page > 0 ? page : 1,
      limit: Number.isFinite(limit) ? Math.min(50, Math.max(1, limit)) : 25,
    });
    return json(c, result);
  });

  app.get("/api/admin/users/:userId", async (c) => {
    const access = await requirePermission(c, "users.read");
    if ("response" in access) return access.response;
    const detail = await getAdminUser(db, c.req.param("userId"));
    if (!detail) return json(c, { error: "User not found" }, 404);
    return json(c, { user: detail });
  });

  app.post("/api/admin/users", async (c) => {
    const access = await requirePermission(c, "users.create");
    if ("response" in access) return access.response;
    const parsed = createUserSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json(c, validationError(parsed.error), 400);
    const result = await createDirectUser(db, access.user, parsed.data, c.req.raw.headers);
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result, 200);
  });

  app.post("/api/admin/users/invite", async (c) => {
    const access = await requirePermission(c, "users.invite");
    if ("response" in access) return access.response;
    const parsed = inviteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json(c, validationError(parsed.error), 400);
    const result = await createInvitation(db, access.user, parsed.data);
    if ("error" in result) return json(c, { error: result.error, invitation: "invitation" in result ? result.invitation : undefined }, result.status);
    return json(c, result, 200);
  });

  app.get("/api/admin/invitations", async (c) => {
    const access = await requirePermission(c, "users.invite");
    if ("response" in access) return access.response;
    return json(c, { invitations: await listInvitations(db) });
  });

  app.post("/api/admin/invitations/:id/revoke", async (c) => {
    const access = await requirePermission(c, "users.invite");
    if ("response" in access) return access.response;
    return json(c, await revokeInvitation(db, access.user.id, c.req.param("id")));
  });

  app.patch("/api/admin/users/:userId", async (c) => {
    const access = await requirePermission(c, "users.update");
    if ("response" in access) return access.response;
    const parsed = userUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json(c, validationError(parsed.error), 400);
    const result = await updateAdminUser(db, access.user, c.req.param("userId"), parsed.data);
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result);
  });

  app.post("/api/admin/users/:userId/verify-email", async (c) => {
    const account = await getSessionUser(c.req.raw.headers);
    if (!account) return json(c, { error: "Unauthorized" }, 401);
    if ((account as { banned?: boolean }).banned) {
      return json(c, { error: "This account cannot access SendStack." }, 403);
    }
    const parsed = manualEmailVerificationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json(c, validationError(parsed.error), 400);
    const result = await manuallyVerifyUserEmail(
      db,
      { id: account.id, role: (account as { role?: string | null }).role, banned: false },
      { userId: c.req.param("userId"), ...parsed.data },
    );
    if (!result.ok) return json(c, { error: result.error }, result.status);
    const detail = await getAdminUser(db, c.req.param("userId"));
    return json(c, { user: detail });
  });

  app.post("/api/admin/users/:userId/status", async (c) => {
    const access = await requirePermission(c, "users.deactivate");
    if ("response" in access) return access.response;
    const parsed = statusSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json(c, validationError(parsed.error), 400);
    const result = await setUserStatus(db, access.user, c.req.param("userId"), parsed.data.status);
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result);
  });

  app.delete("/api/admin/users/:userId/sessions/:sessionId", async (c) => {
    const access = await requirePermission(c, "users.manage_sessions");
    if ("response" in access) return access.response;
    await revokeUserSessions(db, access.user.id, c.req.param("userId"), c.req.param("sessionId"));
    return json(c, { ok: true });
  });

  app.delete("/api/admin/users/:userId/sessions", async (c) => {
    const access = await requirePermission(c, "users.manage_sessions");
    if ("response" in access) return access.response;
    await revokeUserSessions(db, access.user.id, c.req.param("userId"));
    return json(c, { ok: true });
  });

  app.post("/api/admin/users/:userId/password-reset", async (c) => {
    const access = await requirePermission(c, "users.reset_password");
    if ("response" in access) return access.response;
    const result = await requestUserPasswordReset(db, access.user.id, c.req.param("userId"), c.req.raw.headers);
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result);
  });

  app.delete("/api/admin/users/:userId", async (c) => {
    const access = await requirePermission(c, "users.delete");
    if ("response" in access) return access.response;
    const result = await deactivateOrDeleteUser(db, access.user.id, c.req.param("userId"));
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result);
  });

  app.get("/api/admin/roles", async (c) => {
    const access = await requirePermission(c, "roles.read");
    if ("response" in access) return access.response;
    return json(c, { roles: await listRoles(db) });
  });

  app.get("/api/admin/roles/:roleId", async (c) => {
    const access = await requirePermission(c, "roles.read");
    if ("response" in access) return access.response;
    const role = await getRole(db, c.req.param("roleId"));
    if (!role) return json(c, { error: "Role not found" }, 404);
    return json(c, { role });
  });

  app.post("/api/admin/roles", async (c) => {
    const access = await requirePermission(c, "roles.create");
    if ("response" in access) return access.response;
    const parsed = roleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json(c, validationError(parsed.error), 400);
    const result = await saveRole(db, access.user.id, parsed.data);
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result);
  });

  app.patch("/api/admin/roles/:roleId", async (c) => {
    const access = await requirePermission(c, "roles.update");
    if ("response" in access) return access.response;
    const parsed = roleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json(c, validationError(parsed.error), 400);
    const result = await saveRole(db, access.user.id, { ...parsed.data, id: c.req.param("roleId") });
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result);
  });

  app.delete("/api/admin/roles/:roleId", async (c) => {
    const access = await requirePermission(c, "roles.delete");
    if ("response" in access) return access.response;
    const result = await deleteRole(db, access.user.id, c.req.param("roleId"));
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result);
  });

  app.get("/api/admin/audit", async (c) => {
    const access = await requirePermission(c, "audit.read");
    if ("response" in access) return access.response;
    const page = Number(c.req.query("page") ?? "1");
    const limit = Number(c.req.query("limit") ?? "25");
    return json(c, await listAudit(db, page > 0 ? page : 1, Math.min(50, limit > 0 ? limit : 25)));
  });

  app.post("/api/invitations/accept", async (c) => {
    const account = await getSessionUser(c.req.raw.headers);
    if (!account) return json(c, { error: "Sign in with the invited email address first." }, 401);
    const parsed = z.object({ token: z.string().min(20) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return json(c, { error: "This invitation is not valid." }, 400);
    const result = await acceptInvitation(
      db,
      { id: account.id, email: account.email, emailVerified: Boolean(account.emailVerified) },
      parsed.data.token,
    );
    if ("error" in result) return json(c, { error: result.error }, result.status);
    return json(c, result);
  });

  app.get("/api/me", async (c) => {
    const account = await getSessionUser(c.req.raw.headers);
    if (!account) return json(c, { error: "Unauthorized" }, 401);
    const permissions = [...(await permissionsForUser(db, account))].sort();
    return json(c, {
      user: {
        id: account.id,
        name: account.name,
        email: account.email,
        emailVerified: account.emailVerified,
        role: (account as { role?: string }).role ?? "user",
        banned: Boolean((account as { banned?: boolean }).banned),
      },
      permissions,
    });
  });
}
