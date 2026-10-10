import { useEffect, useState } from "react";

import { authClient } from "@/lib/auth-client";

const SUPER_ADMIN_NAV = ["mailbox.read", "mailbox.send", "users.read", "roles.read", "audit.read"];

export function useAuthorization() {
  const { data: session } = authClient.useSession();
  const role = (session?.user as { role?: string } | undefined)?.role ?? "";
  const [serverPermissions, setServerPermissions] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "include" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((payload: { permissions?: string[] } | null) => {
        if (cancelled) return;
        setServerPermissions(payload?.permissions ?? []);
      })
      .catch(() => {
        if (!cancelled) setServerPermissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  const permissions = new Set(
    serverPermissions ?? (role.split(",").includes("super-admin") ? SUPER_ADMIN_NAV : []),
  );

  return {
    permissions,
    can: (permission: string) => permissions.has(permission),
    loaded: serverPermissions !== null,
  };
}
