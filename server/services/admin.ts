import { createHash, randomBytes } from "node:crypto";

import { and, count, desc, eq, gte, ilike, or } from "drizzle-orm";

import { loadEnv } from "../env.js";
import { auth } from "../auth/auth.js";
import {
  PERMISSION_DETAILS,
  parseRoleKeys,
  ROLE_TEMPLATES,
  type SystemRoleKey,
} from "../auth/permissions.js";
import { customRoleKeyError, invalidPermissionKeys, roleGrantError } from "../auth/policy.js";
import type { Database } from "../db/index.js";
import {
  adminAuditEvents,
  appPermissions,
  appRolePermissions,
  appRoles,
  appUserAccess,
  appUserRoles,
  session,
  user,
  userInvitations,
} from "../db/schema.js";
import { sendTransactionalEmail } from "../lib/email.js";
import { withPgAdvisoryLock } from "../mail/lock.js";
import { permissionsForUser } from "./access-control.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_HOURLY_LIMIT = 10;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function roleIdFor(key: string) {
  return `role_${key}`;
}

export async function recordAudit(
  db: Database,
  input: {
    actorUserId: string | null;
    targetUserId?: string | null;
    action: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(adminAuditEvents).values({
    id: crypto.randomUUID(),
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId ?? null,
    action: input.action,
    metadata: input.metadata,
  });
}

async function rolePermissionMap(db: Database) {
  const rows = await db
    .select({ roleKey: appRoles.key, permissionKey: appPermissions.key })
    .from(appRolePermissions)
    .innerJoin(appRoles, eq(appRoles.id, appRolePermissions.roleId))
    .innerJoin(appPermissions, eq(appPermissions.id, appRolePermissions.permissionId));
  const map: Record<string, string[]> = {};
  for (const row of rows) {
    map[row.roleKey] ??= [];
    map[row.roleKey]?.push(row.permissionKey);
  }
  for (const key of Object.keys(ROLE_TEMPLATES) as SystemRoleKey[]) {
    if (!map[key]) map[key] = [...ROLE_TEMPLATES[key].permissions];
  }
  return map;
}

async function countActiveSuperAdmins(db: Database) {
  const rows = await db.select({ id: user.id, role: user.role, banned: user.banned }).from(user);
  const accessRows = await db.select().from(appUserAccess);
  const access = new Map(accessRows.map((row) => [row.userId, row.status]));
  return rows.filter((row) => {
    const status = access.get(row.id) ?? "active";
    return parseRoleKeys(row.role).includes("super-admin") && status === "active" && !row.banned;
  }).length;
}

export async function listAdminUsers(
  db: Database,
  query: { search?: string; role?: string; status?: string; page: number; limit: number },
) {
  const filters = [];
  if (query.search) {
    const term = `%${query.search}%`;
    filters.push(or(ilike(user.name, term), ilike(user.email, term)));
  }
  const where = filters.length ? and(...filters) : undefined;
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(where)
    .orderBy(desc(user.createdAt));

  const accessRows = await db.select().from(appUserAccess);
  const access = new Map(accessRows.map((row) => [row.userId, row.status]));
  const extraRoles = await db
    .select({ userId: appUserRoles.userId, key: appRoles.key })
    .from(appUserRoles)
    .innerJoin(appRoles, eq(appRoles.id, appUserRoles.roleId));
  const extras = new Map<string, string[]>();
  for (const row of extraRoles) {
    const list = extras.get(row.userId) ?? [];
    list.push(row.key);
    extras.set(row.userId, list);
  }
  const sessionRows = await db
    .select({ userId: session.userId, updatedAt: session.updatedAt })
    .from(session);
  const lastSession = new Map<string, Date>();
  for (const row of sessionRows) {
    const current = lastSession.get(row.userId);
    if (!current || row.updatedAt > current) lastSession.set(row.userId, row.updatedAt);
  }

  let items = rows.map((row) => {
    const roles = [...new Set([...parseRoleKeys(row.role), ...(extras.get(row.id) ?? [])])];
    const status = access.get(row.id) ?? (row.banned ? "suspended" : "active");
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      roles,
      status,
      emailVerified: row.emailVerified,
      createdAt: row.createdAt.toISOString(),
      lastSessionAt: lastSession.get(row.id)?.toISOString() ?? null,
    };
  });
  if (query.role) items = items.filter((item) => item.roles.includes(query.role ?? ""));
  if (query.status) items = items.filter((item) => item.status === query.status);
  const total = items.length;
  const start = (query.page - 1) * query.limit;
  const pageItems = items.slice(start, start + query.limit);
  const invitations = await db.select({ deliveryStatus: userInvitations.deliveryStatus, acceptedAt: userInvitations.acceptedAt, revokedAt: userInvitations.revokedAt, expiresAt: userInvitations.expiresAt }).from(userInvitations);
  const now = Date.now();
  const pendingInvitations = invitations.filter((row) => !row.acceptedAt && !row.revokedAt && row.expiresAt.getTime() > now).length;
  return {
    users: pageItems,
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
    stats: {
      total: rows.length,
      active: items.filter((item) => item.status === "active").length,
      suspended: items.filter((item) => item.status === "suspended").length,
      pendingInvitations,
    },
  };
}

export async function getAdminUser(db: Database, userId: string) {
  const [account] = await db
    .select()
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!account) return null;
  const [access] = await db.select().from(appUserAccess).where(eq(appUserAccess.userId, userId)).limit(1);
  const extras = await db
    .select({ key: appRoles.key, name: appRoles.name })
    .from(appUserRoles)
    .innerJoin(appRoles, eq(appRoles.id, appUserRoles.roleId))
    .where(eq(appUserRoles.userId, userId));
  const roles = [...new Set([...parseRoleKeys(account.role), ...extras.map((row) => row.key)])];
  const permissions = [...(await permissionsForUser(db, account))].sort();
  const sessions = await db
    .select({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(desc(session.updatedAt));
  const events = await db
    .select()
    .from(adminAuditEvents)
    .where(eq(adminAuditEvents.targetUserId, userId))
    .orderBy(desc(adminAuditEvents.createdAt))
    .limit(20);
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    emailVerified: account.emailVerified,
    roles,
    status: access?.status ?? (account.banned ? "suspended" : "active"),
    permissions,
    createdAt: account.createdAt.toISOString(),
    sessions: sessions.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
    })),
    audit: events.map((row) => ({
      id: row.id,
      action: row.action,
      actorUserId: row.actorUserId,
      createdAt: row.createdAt.toISOString(),
      metadata: row.metadata ?? {},
    })),
  };
}

async function syncUserRoles(db: Database, userId: string, roleKeys: string[], actorId: string) {
  const registered = new Set<string>(Object.keys(ROLE_TEMPLATES));
  const authRoles = roleKeys.filter((key) => registered.has(key));
  await db.update(user).set({ role: authRoles.join(",") || "user", updatedAt: new Date() }).where(eq(user.id, userId));
  await db.delete(appUserRoles).where(eq(appUserRoles.userId, userId));
  if (roleKeys.length) {
    await db.insert(appUserRoles).values(
      roleKeys.map((key) => ({
        userId,
        roleId: roleIdFor(key),
        assignedBy: actorId,
      })),
    );
  }
}

export async function updateAdminUser(
  db: Database,
  actor: { id: string; role?: string | null },
  userId: string,
  input: { name?: string; roleKeys?: string[] },
) {
  return withPgAdvisoryLock(db, "sendstack-last-super-admin", async () => {
    const [target] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
    if (!target) return { error: "User not found", status: 404 as const };
    const actorPermissions = await permissionsForUser(db, actor);
    const actorIsSuperAdmin = parseRoleKeys(actor.role).includes("super-admin");
    if (input.roleKeys) {
      const map = await rolePermissionMap(db);
      const activeSuperAdmins = await countActiveSuperAdmins(db);
      const [access] = await db.select().from(appUserAccess).where(eq(appUserAccess.userId, userId)).limit(1);
      const targetIsActiveSuperAdmin =
        parseRoleKeys(target.role).includes("super-admin") && (access?.status ?? "active") === "active" && !target.banned;
      const grantError = roleGrantError({
        actorIsSuperAdmin,
        actorPermissions,
        nextRoleKeys: input.roleKeys,
        rolePermissions: map,
        actorId: actor.id,
        targetId: userId,
        activeSuperAdmins,
        targetIsActiveSuperAdmin,
      });
      if (grantError) return { error: grantError, status: 403 as const };
      const known = await db.select({ key: appRoles.key }).from(appRoles);
      const knownKeys = new Set(known.map((row) => row.key));
      if (input.roleKeys.some((key) => !knownKeys.has(key))) {
        return { error: "One or more roles do not exist.", status: 400 as const };
      }
      await syncUserRoles(db, userId, input.roleKeys, actor.id);
      await recordAudit(db, {
        actorUserId: actor.id,
        targetUserId: userId,
        action: "roles_assigned",
        metadata: { roles: input.roleKeys },
      });
    }
    if (input.name && input.name !== target.name) {
      await db.update(user).set({ name: input.name, updatedAt: new Date() }).where(eq(user.id, userId));
      await recordAudit(db, { actorUserId: actor.id, targetUserId: userId, action: "user_updated", metadata: { name: input.name } });
    }
    return { user: await getAdminUser(db, userId) };
  });
}

export async function setUserStatus(
  db: Database,
  actor: { id: string; role?: string | null },
  userId: string,
  status: "active" | "suspended" | "deactivated",
) {
  return withPgAdvisoryLock(db, "sendstack-last-super-admin", async () => {
    const [target] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
    if (!target) return { error: "User not found", status: 404 as const };
    const activeSuperAdmins = await countActiveSuperAdmins(db);
    const targetIsActiveSuperAdmin = parseRoleKeys(target.role).includes("super-admin") && !target.banned;
    if (status !== "active" && !superAdminChangeAllowed(activeSuperAdmins, targetIsActiveSuperAdmin)) {
      return { error: "The last active super admin cannot be suspended or deactivated.", status: 403 as const };
    }
    await db
      .insert(appUserAccess)
      .values({ userId, status, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appUserAccess.userId, set: { status, updatedAt: new Date() } });
    await db
      .update(user)
      .set({
        banned: status !== "active",
        banReason: status === "active" ? null : status,
        banExpires: null,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId));
    if (status !== "active") {
      await db.delete(session).where(eq(session.userId, userId));
    }
    await recordAudit(db, {
      actorUserId: actor.id,
      targetUserId: userId,
      action: status === "active" ? "user_reactivated" : status === "suspended" ? "user_suspended" : "user_deactivated",
    });
    return { user: await getAdminUser(db, userId) };
  });
}

function superAdminChangeAllowed(activeSuperAdmins: number, targetIsActiveSuperAdmin: boolean) {
  return !(targetIsActiveSuperAdmin && activeSuperAdmins <= 1);
}

export async function revokeUserSessions(db: Database, actorId: string, userId: string, sessionId?: string) {
  if (sessionId) {
    await db.delete(session).where(and(eq(session.id, sessionId), eq(session.userId, userId)));
  } else {
    await db.delete(session).where(eq(session.userId, userId));
  }
  await recordAudit(db, {
    actorUserId: actorId,
    targetUserId: userId,
    action: "sessions_revoked",
    metadata: { sessionId: sessionId ?? "all" },
  });
}

export async function requestUserPasswordReset(db: Database, actorId: string, userId: string, headers: Headers) {
  const [account] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!account) return { error: "User not found", status: 404 as const };
  const env = loadEnv();
  let delivered = false;
  let errorMessage: string | null = null;
  try {
    await auth.api.requestPasswordReset({
      body: { email: account.email, redirectTo: `${env.FRONTEND_URL}/reset-password/` },
      headers,
    });
    delivered = true;
  } catch (error) {
    errorMessage = error instanceof Error ? "The reset email could not be sent." : "The reset email could not be sent.";
  }
  await recordAudit(db, {
    actorUserId: actorId,
    targetUserId: userId,
    action: "password_reset_requested",
    metadata: { delivered },
  });
  if (!delivered) return { error: errorMessage ?? "The reset email could not be sent.", status: 502 as const };
  return { ok: true as const };
}

export async function deactivateOrDeleteUser(db: Database, actorId: string, userId: string) {
  const statusResult = await setUserStatus(db, { id: actorId }, userId, "deactivated");
  if ("error" in statusResult) return statusResult;
  await recordAudit(db, {
    actorUserId: actorId,
    targetUserId: userId,
    action: "user_deactivated",
    metadata: { retention: "Account access disabled. Campaigns, drafts, contacts, and history were kept." },
  });
  return statusResult;
}

export async function listRoles(db: Database) {
  const roles = await db.select().from(appRoles).orderBy(appRoles.name);
  const permissionCounts = await db
    .select({ roleId: appRolePermissions.roleId, total: count() })
    .from(appRolePermissions)
    .groupBy(appRolePermissions.roleId);
  const userCounts = await db
    .select({ roleId: appUserRoles.roleId, total: count() })
    .from(appUserRoles)
    .groupBy(appUserRoles.roleId);
  const permissionMap = new Map(permissionCounts.map((row) => [row.roleId, Number(row.total)]));
  const userMap = new Map(userCounts.map((row) => [row.roleId, Number(row.total)]));
  return roles.map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissionCount: permissionMap.get(role.id) ?? 0,
    userCount: userMap.get(role.id) ?? 0,
  }));
}

export async function getRole(db: Database, roleId: string) {
  const [role] = await db.select().from(appRoles).where(eq(appRoles.id, roleId)).limit(1);
  if (!role) return null;
  const permissions = await db
    .select({ key: appPermissions.key })
    .from(appRolePermissions)
    .innerJoin(appPermissions, eq(appPermissions.id, appRolePermissions.permissionId))
    .where(eq(appRolePermissions.roleId, roleId));
  return {
    ...role,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
    permissions: permissions.map((row) => row.key),
  };
}

export async function saveRole(
  db: Database,
  actorId: string,
  input: { id?: string; key: string; name: string; description: string; permissions: string[] },
) {
  const invalid = invalidPermissionKeys(input.permissions);
  if (invalid.length) return { error: "One or more permissions are not valid.", status: 400 as const };
  if (input.permissions.some((key) => key.startsWith("mailbox.") || key === "roles.assign" || key === "permissions.manage" || key === "users.delete")) {
    return { error: "That permission can only be held by the super-admin role.", status: 403 as const };
  }
  if (!input.id) {
    const keyError = customRoleKeyError(input.key);
    if (keyError) return { error: keyError, status: 400 as const };
    const id = roleIdFor(input.key);
    await db.insert(appRoles).values({
      id,
      key: input.key,
      name: input.name,
      description: input.description,
      isSystem: false,
    });
    if (input.permissions.length) {
      await db.insert(appRolePermissions).values(input.permissions.map((permission) => ({ roleId: id, permissionId: permission })));
    }
    await recordAudit(db, { actorUserId: actorId, action: "role_created", metadata: { key: input.key } });
    return { role: await getRole(db, id) };
  }
  const [existing] = await db.select().from(appRoles).where(eq(appRoles.id, input.id)).limit(1);
  if (!existing) return { error: "Role not found", status: 404 as const };
  if (existing.isSystem) return { error: "System roles cannot be edited.", status: 403 as const };
  await db.update(appRoles).set({ name: input.name, description: input.description, updatedAt: new Date() }).where(eq(appRoles.id, input.id));
  await db.delete(appRolePermissions).where(eq(appRolePermissions.roleId, input.id));
  if (input.permissions.length) {
    await db.insert(appRolePermissions).values(input.permissions.map((permission) => ({ roleId: input.id as string, permissionId: permission })));
  }
  await recordAudit(db, { actorUserId: actorId, action: "role_updated", metadata: { key: existing.key } });
  return { role: await getRole(db, input.id) };
}

export async function deleteRole(db: Database, actorId: string, roleId: string) {
  const [existing] = await db.select().from(appRoles).where(eq(appRoles.id, roleId)).limit(1);
  if (!existing) return { error: "Role not found", status: 404 as const };
  if (existing.isSystem) return { error: "System roles cannot be deleted.", status: 403 as const };
  await db.delete(appRoles).where(eq(appRoles.id, roleId));
  await recordAudit(db, { actorUserId: actorId, action: "role_deleted", metadata: { key: existing.key } });
  return { ok: true as const };
}

export async function createInvitation(
  db: Database,
  actor: { id: string; role?: string | null },
  input: { email: string; roleKeys: string[] },
) {
  const recent = await db
    .select({ id: userInvitations.id })
    .from(userInvitations)
    .where(gte(userInvitations.createdAt, new Date(Date.now() - 60 * 60 * 1000)));
  if (recent.length >= INVITE_HOURLY_LIMIT) {
    return { error: "Invitation sending is temporarily limited.", status: 429 as const };
  }
  const actorPermissions = await permissionsForUser(db, actor);
  const map = await rolePermissionMap(db);
  const grantError = roleGrantError({
    actorIsSuperAdmin: parseRoleKeys(actor.role).includes("super-admin"),
    actorPermissions,
    nextRoleKeys: input.roleKeys,
    rolePermissions: map,
    actorId: actor.id,
    targetId: "invitation",
    activeSuperAdmins: await countActiveSuperAdmins(db),
    targetIsActiveSuperAdmin: false,
  });
  if (grantError) return { error: grantError, status: 403 as const };
  const email = input.email.trim().toLowerCase();
  const [existingUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existingUser) return { error: "An account with that email already exists.", status: 409 as const };
  const token = randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  await db.insert(userInvitations).values({
    id,
    email,
    roleKeys: input.roleKeys,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    invitedBy: actor.id,
    deliveryStatus: "pending",
  });
  const env = loadEnv();
  const link = `${env.FRONTEND_URL}/invite/?token=${encodeURIComponent(token)}`;
  let deliveryStatus = "sent";
  let deliveryError: string | null = null;
  try {
    const result = await sendTransactionalEmail(env, {
      to: email,
      subject: "You are invited to SendStack",
      text: `You have been invited to SendStack.\n\nAccept the invitation: ${link}\n\nThis link expires in 7 days and can be used once.`,
    });
    if (!result.delivered) {
      deliveryStatus = "not_sent";
      deliveryError = "Email delivery is not configured, so the invitation was saved but not sent.";
    }
  } catch {
    deliveryStatus = "failed";
    deliveryError = "The invitation was saved, but the email could not be sent.";
  }
  await db.update(userInvitations).set({ deliveryStatus, deliveryError }).where(eq(userInvitations.id, id));
  await recordAudit(db, {
    actorUserId: actor.id,
    action: "user_invited",
    metadata: { email, roles: input.roleKeys, deliveryStatus },
  });
  return {
    invitation: { id, email, roleKeys: input.roleKeys, deliveryStatus, deliveryError, expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() },
  };
}

export async function listInvitations(db: Database) {
  const rows = await db.select().from(userInvitations).orderBy(desc(userInvitations.createdAt)).limit(50);
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    roleKeys: row.roleKeys,
    deliveryStatus: row.deliveryStatus,
    deliveryError: row.deliveryError,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.revokedAt ? "revoked" : row.acceptedAt ? "accepted" : row.expiresAt.getTime() < now ? "expired" : "pending",
  }));
}

export async function revokeInvitation(db: Database, actorId: string, invitationId: string) {
  await db.update(userInvitations).set({ revokedAt: new Date() }).where(eq(userInvitations.id, invitationId));
  await recordAudit(db, { actorUserId: actorId, action: "invitation_revoked", metadata: { invitationId } });
  return { ok: true as const };
}

export async function acceptInvitation(db: Database, account: { id: string; email: string; emailVerified: boolean }, token: string) {
  const [invite] = await db.select().from(userInvitations).where(eq(userInvitations.tokenHash, hashToken(token))).limit(1);
  if (!invite) return { error: "This invitation is not valid.", status: 400 as const };
  if (invite.revokedAt) return { error: "This invitation has been revoked.", status: 400 as const };
  if (invite.acceptedAt) return { error: "This invitation has already been used.", status: 400 as const };
  if (invite.expiresAt.getTime() < Date.now()) return { error: "This invitation has expired.", status: 400 as const };
  if (invite.email !== account.email.trim().toLowerCase()) {
    return { error: "Sign in with the invited email address before accepting.", status: 403 as const };
  }
  if (!account.emailVerified) {
    return { error: "Verify your email address before accepting the invitation.", status: 403 as const };
  }
  await syncUserRoles(db, account.id, invite.roleKeys, invite.invitedBy ?? account.id);
  await db.update(userInvitations).set({ acceptedAt: new Date(), tokenHash: hashToken(randomBytes(32).toString("hex")) }).where(eq(userInvitations.id, invite.id));
  await recordAudit(db, {
    actorUserId: account.id,
    targetUserId: account.id,
    action: "invitation_accepted",
    metadata: { roles: invite.roleKeys },
  });
  return { ok: true as const };
}

export async function listAudit(db: Database, page: number, limit: number) {
  const rows = await db.select().from(adminAuditEvents).orderBy(desc(adminAuditEvents.createdAt)).limit(limit).offset((page - 1) * limit);
  const [totalRow] = await db.select({ total: count() }).from(adminAuditEvents);
  return {
    events: rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorUserId: row.actorUserId,
      targetUserId: row.targetUserId,
      metadata: row.metadata ?? {},
      createdAt: row.createdAt.toISOString(),
    })),
    pagination: { page, limit, total: Number(totalRow?.total ?? 0), totalPages: Math.max(1, Math.ceil(Number(totalRow?.total ?? 0) / limit)) },
  };
}

export function listPermissionCatalog() {
  return Object.entries(PERMISSION_DETAILS).map(([key, detail]) => ({ key, ...detail }));
}
