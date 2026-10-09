import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

/**
 * SendStack role model:
 * - user: default self-service registrations (no admin permissions)
 * - super-admin: full admin plugin permissions
 */
export const sendstackAccessControl = createAccessControl(defaultStatements);

const userRole = sendstackAccessControl.newRole({
  user: [],
  session: [],
});

const superAdminRole = sendstackAccessControl.newRole({
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "impersonate",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
  session: ["list", "revoke", "delete"],
});

export const sendstackAdminRoles = {
  user: userRole,
  "super-admin": superAdminRole,
};
