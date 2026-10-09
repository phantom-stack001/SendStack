import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

/**
 * Better Auth admin-plugin roles.
 * Only super-admin may call the admin plugin.
 * Application permissions live in server/auth/permissions.ts and are enforced by SendStack.
 */
export const sendstackAccessControl = createAccessControl(defaultStatements);

const noAdminPluginAccess = { user: [], session: [] } as const;

const userRole = sendstackAccessControl.newRole(noAdminPluginAccess);
const viewerRole = sendstackAccessControl.newRole(noAdminPluginAccess);
const editorRole = sendstackAccessControl.newRole(noAdminPluginAccess);
const campaignManagerRole = sendstackAccessControl.newRole(noAdminPluginAccess);
const adminRole = sendstackAccessControl.newRole(noAdminPluginAccess);

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
  viewer: viewerRole,
  editor: editorRole,
  "campaign-manager": campaignManagerRole,
  admin: adminRole,
  "super-admin": superAdminRole,
};
