import { parseRoleKeys, PERMISSIONS, RESERVED_ROLE_KEYS, type PermissionKey } from "./permissions.js";

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function superAdminRemovalAllowed(input: {
  activeSuperAdmins: number;
  targetIsActiveSuperAdmin: boolean;
  nextIncludesSuperAdmin: boolean;
}) {
  if (input.targetIsActiveSuperAdmin && !input.nextIncludesSuperAdmin && input.activeSuperAdmins <= 1) {
    return false;
  }
  return true;
}

export function roleGrantError(input: {
  actorIsSuperAdmin: boolean;
  actorPermissions: ReadonlySet<string>;
  nextRoleKeys: string[];
  rolePermissions: Record<string, readonly string[]>;
  actorId: string;
  targetId: string;
  activeSuperAdmins: number;
  targetIsActiveSuperAdmin: boolean;
}) {
  if (input.actorId === input.targetId && input.targetIsActiveSuperAdmin && !input.nextRoleKeys.includes("super-admin")) {
    if (input.activeSuperAdmins <= 1) {
      return "You cannot remove your own super-admin access while you are the last active super admin.";
    }
  }

  if (
    !superAdminRemovalAllowed({
      activeSuperAdmins: input.activeSuperAdmins,
      targetIsActiveSuperAdmin: input.targetIsActiveSuperAdmin,
      nextIncludesSuperAdmin: input.nextRoleKeys.includes("super-admin"),
    })
  ) {
    return "The last active super admin cannot be removed.";
  }

  if (!input.actorIsSuperAdmin && input.nextRoleKeys.some((key) => key === "super-admin" || key === "admin")) {
    return "Only a super admin can assign an administrative role.";
  }

  if (!input.actorIsSuperAdmin) {
    for (const key of input.nextRoleKeys) {
      const permissions = input.rolePermissions[key] ?? [];
      if (permissions.some((permission) => !input.actorPermissions.has(permission))) {
        return "You cannot assign a role with permissions you do not have.";
      }
    }
  }

  return null;
}

export function customRoleKeyError(key: string) {
  const normalized = key.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    return "Role keys use lowercase letters, numbers, and hyphens.";
  }
  if (RESERVED_ROLE_KEYS.has(normalized) || normalized.includes("super-admin")) {
    return "That role key is reserved.";
  }
  return null;
}

export function canDirectlyCreatePasswordAccount(role: string | null | undefined) {
  return parseRoleKeys(role).includes("super-admin");
}

export function userCreatedAuditMetadata(input: { roles: string[]; status: string; verificationEmail: string }) {
  return {
    roles: input.roles,
    status: input.status,
    verificationEmail: input.verificationEmail,
  };
}

export function invalidPermissionKeys(keys: string[]) {
  return keys.filter((key) => !PERMISSION_SET.has(key));
}

export type { PermissionKey };
