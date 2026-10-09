import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type UserDetail = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  roles: string[];
  status: string;
  permissions: string[];
  sessions: { id: string; updatedAt: string; ipAddress: string | null; userAgent: string | null; expiresAt: string }[];
  audit: { id: string; action: string; createdAt: string }[];
};

const ASSIGNABLE = ["viewer", "editor", "campaign-manager", "admin", "user"];

export function UserDetailsPage() {
  const { userId = "" } = useParams();
  const [account, setAccount] = useState<UserDetail | null>(null);
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const response = await fetch(`/api/admin/users/${userId}`, { credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "User not found");
      return;
    }
    setAccount(payload.user);
    setName(payload.user.name);
    setRoles(payload.user.roles);
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/users/${userId}`, { credentials: "include" })
      .then(async (response) => {
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.error ?? "User not found");
          return;
        }
        setAccount(payload.user);
        setName(payload.user.name);
        setRoles(payload.user.roles);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this user.");
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function save() {
    setError(null);
    const response = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, roleKeys: roles }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Could not update this user.");
      return;
    }
    setMessage("Account updated.");
    setAccount(payload.user);
  }

  async function setStatus(status: "active" | "suspended" | "deactivated") {
    setError(null);
    const response = await fetch(`/api/admin/users/${userId}/status`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Could not change account status.");
      return;
    }
    setAccount(payload.user);
  }

  async function resetPassword() {
    const response = await fetch(`/api/admin/users/${userId}/password-reset`, { method: "POST", credentials: "include" });
    const payload = await response.json();
    setMessage(response.ok ? "Password reset email requested." : payload.error);
  }

  async function revokeSessions() {
    const response = await fetch(`/api/admin/users/${userId}/sessions`, { method: "DELETE", credentials: "include" });
    setMessage(response.ok ? "Sessions revoked." : "Could not revoke sessions.");
    await load();
  }

  if (!account) {
    return <AppPageContainer><p className="text-sm text-muted-foreground">{error ?? "Loading account…"}</p></AppPageContainer>;
  }

  return (
    <>
      <PageMeta title={`${account.name} | SendStack`} description="User account details." canonicalPath={`/app/admin/users/${account.id}/`} />
      <AppPageContainer className="max-w-none">
        <div className="flex items-start justify-between gap-3">
          <PageHeader title={account.name} description={account.email} />
          <Button variant="outline" asChild><Link to="/app/admin/users/">Back</Link></Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {message ? <p className="text-sm">{message}</p> : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" />
              <p className="text-sm text-muted-foreground">Email changes require a verification flow and are not changed here.</p>
              <p className="text-sm">Verification: {account.emailVerified ? "Verified" : "Not verified"}</p>
              <p className="text-sm capitalize">Status: {account.status}</p>
              <Button type="button" onClick={() => void save()}>Save profile</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Access</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {ASSIGNABLE.map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={roles.includes(key)}
                    onChange={(event) => {
                      setRoles((current) => event.target.checked ? [...current, key] : current.filter((item) => item !== key));
                    }}
                  />
                  {key}
                </label>
              ))}
              {roles.includes("super-admin") ? <Badge>super-admin</Badge> : null}
              <div className="flex flex-wrap gap-1">
                {account.permissions.slice(0, 12).map((permission) => <Badge key={permission} variant="outline">{permission}</Badge>)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Security</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => void setStatus("suspended")}>Suspend</Button>
                <Button type="button" variant="outline" onClick={() => void setStatus("active")}>Reactivate</Button>
                <Button type="button" variant="outline" onClick={() => void setStatus("deactivated")}>Deactivate</Button>
                <Button type="button" variant="outline" onClick={() => void revokeSessions()}>Revoke sessions</Button>
                <Button type="button" variant="outline" onClick={() => void resetPassword()}>Reset password</Button>
              </div>
              <ul className="space-y-2 text-sm">
                {account.sessions.map((item) => (
                  <li key={item.id} className="break-words text-muted-foreground">
                    {new Date(item.updatedAt).toLocaleString()} · {item.ipAddress ?? "Unknown IP"} · {item.userAgent ?? "Unknown device"}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {account.audit.length === 0 ? <li className="text-muted-foreground">No administrative events yet.</li> : null}
                {account.audit.map((event) => (
                  <li key={event.id}>{event.action} · {new Date(event.createdAt).toLocaleString()}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </AppPageContainer>
    </>
  );
}
