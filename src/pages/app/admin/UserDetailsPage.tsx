import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

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
  emailVerification?: {
    status: "verified" | "unverified";
    method: "manual" | "unknown" | null;
    verifiedAt: string | null;
    reason: string | null;
  };
};

const ASSIGNABLE = ["viewer", "editor", "campaign-manager", "admin", "user"];

export function UserDetailsPage() {
  const { userId = "" } = useParams();
  const location = useLocation();
  const created = Boolean((location.state as { created?: boolean } | null)?.created);
  const [account, setAccount] = useState<UserDetail | null>(null);
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const { data: session } = authClient.useSession();
  const isSuperAdmin = ((session?.user as { role?: string } | undefined)?.role ?? "")
    .split(",")
    .map((part) => part.trim())
    .includes("super-admin");

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

  function openVerify() {
    setAcknowledged(false);
    setError(null);
    setVerifyOpen(true);
  }

  async function confirmVerify() {
    if (!account || verifying || !acknowledged) return;
    setVerifying(true);
    setError(null);
    const response = await fetch(`/api/admin/users/${userId}/verify-email`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        expectedEmail: account.email,
      }),
    });
    const payload = await response.json();
    setVerifying(false);
    if (!response.ok || !payload.user) {
      setError(payload.error ?? "Could not verify this email address.");
      return;
    }
    setAccount(payload.user);
    setName(payload.user.name);
    setRoles(payload.user.roles);
    setAcknowledged(false);
    setVerifyOpen(false);
    setMessage("Email address manually verified.");
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
      <AppPageContainer className="max-w-[90rem]">
        <PageHeader
          title={account.name}
          description={account.email}
          actions={<Button variant="outline" asChild><Link to="/app/admin/users/">Back</Link></Button>}
        />
        {created ? <p className="text-sm" role="status">User created successfully.</p> : null}
        {error && !verifyOpen ? <p className="text-sm text-destructive">{error}</p> : null}
        {message ? <p className="text-sm" role="status">{message}</p> : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" />
              <p className="text-sm text-muted-foreground">Email changes require a verification flow and are not changed here.</p>
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-sm font-medium">Email verification</p>
                <p className="break-all text-sm">{account.email}</p>
                <p className="text-sm">Status: {account.emailVerified ? "Verified" : "Unverified"}</p>
                {account.emailVerified ? (
                  <>
                    <p className="text-sm">
                      Verified on: {account.emailVerification?.verifiedAt ? new Date(account.emailVerification.verifiedAt).toLocaleString() : "Not recorded"}
                    </p>
                    <p className="text-sm">
                      Verification method: {account.emailVerification?.method === "manual" ? "Manual" : "Unknown"}
                    </p>
                  </>
                ) : isSuperAdmin ? (
                  <Button type="button" variant="outline" onClick={openVerify}>Verify Email Manually</Button>
                ) : null}
              </div>
              <p className="text-sm capitalize">Status: {account.status}</p>
              <Button type="button" onClick={() => void save()}>Save profile</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Access</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {ASSIGNABLE.map((key) => (
                <label key={key} className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    className="size-5"
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
        <Dialog open={verifyOpen} onOpenChange={(open) => { if (!verifying) setVerifyOpen(open); }}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Verify Email Manually</DialogTitle>
              <DialogDescription>
                Confirm that you have verified this user&apos;s email address.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p className="wrap-break-word"><span className="text-muted-foreground">Name: </span>{account.name}</p>
              <p className="break-all"><span className="text-muted-foreground">Email: </span>{account.email}</p>
              <p><span className="text-muted-foreground">Current status: </span>{account.emailVerified ? "Verified" : "Unverified"}</p>
            </div>
            <label className="flex min-h-11 items-start gap-3 text-sm">
              <input
                className="mt-1 size-5 shrink-0"
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>I confirm that I have verified this user&apos;s email address.</span>
            </label>
            {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={verifying} onClick={() => setVerifyOpen(false)}>Cancel</Button>
              <Button
                type="button"
                disabled={verifying || !acknowledged}
                onClick={() => void confirmVerify()}
              >
                {verifying ? "Verifying…" : "Confirm Verification"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </AppPageContainer>
    </>
  );
}
