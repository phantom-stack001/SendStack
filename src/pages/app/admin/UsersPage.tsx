import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type UserRow = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  status: string;
  emailVerified: boolean;
  createdAt: string;
  lastSessionAt: string | null;
};

type Invitation = {
  id: string;
  email: string;
  roleKeys: string[];
  status: string;
  deliveryStatus: string;
  deliveryError: string | null;
};

export function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, suspended: 0, pendingInvitations: 0 });
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("");
  const [roleOptions, setRoleOptions] = useState<{ id: string; key: string; name: string }[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const params = new URLSearchParams({ search, role, status, page: "1", limit: "25" });
    const response = await fetch(`/api/admin/users?${params}`, { credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Could not load users.");
      return;
    }
    setUsers(payload.users);
    setStats(payload.stats);
    const invites = await fetch("/api/admin/invitations", { credentials: "include" });
    if (invites.ok) {
      const body = await invites.json();
      setInvitations(body.invitations ?? []);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ search, role, status, page: "1", limit: "25" });
    fetch(`/api/admin/users?${params}`, { credentials: "include" })
      .then(async (response) => {
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.error ?? "Could not load users.");
          return;
        }
        setUsers(payload.users);
        setStats(payload.stats);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load users.");
      });
    fetch("/api/admin/roles", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const payload = await response.json();
        const options = (payload.roles ?? []) as { id: string; key: string; name: string }[];
        if (cancelled) return;
        setRoleOptions(options);
        setInviteRole((current) => current || options.find((item) => item.key === "viewer")?.key || options[0]?.key || "");
      })
      .catch(() => undefined);
    fetch("/api/admin/invitations", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const payload = await response.json();
        if (!cancelled) setInvitations(payload.invitations ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [search, role, status]);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    const response = await fetch("/api/admin/users/invite", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, roleKeys: [inviteRole] }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "The invitation could not be created.");
      return;
    }
    const delivery = payload.invitation?.deliveryStatus;
    setMessage(
      delivery === "sent"
        ? "Invitation email sent."
        : payload.invitation?.deliveryError ?? "Invitation saved, but the email was not sent.",
    );
    setEmail("");
    await load();
  }

  return (
    <>
      <PageMeta title="Users | SendStack" description="Manage accounts, access, and permissions." canonicalPath="/app/admin/users/" />
      <AppPageContainer className="max-w-none">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <PageHeader title="Users" description="Manage accounts, access, and permissions." />
          <div className="flex flex-wrap gap-2">
            <Button asChild><Link to="/app/admin/users/new/">Create user</Link></Button>
            <Button type="button" variant="outline" onClick={() => setShowInvite((current) => !current)}>Invite user</Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            ["Total", stats.total],
            ["Active", stats.active],
            ["Suspended", stats.suspended],
            ["Pending invitations", stats.pendingInvitations],
          ].map(([label, value]) => (
            <Card key={String(label)}>
              <CardContent className="py-4">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-semibold">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
        <form className="grid gap-3 rounded-xl border p-4 md:grid-cols-[1fr_12rem_12rem]" onSubmit={(event) => event.preventDefault()}>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or email" aria-label="Search users" />
          <select className="h-9 rounded-md border px-3 text-sm" value={role} onChange={(event) => setRole(event.target.value)} aria-label="Filter by role">
            <option value="">All roles</option>
            {["super-admin", "admin", "campaign-manager", "editor", "viewer", "user"].map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
          <select className="h-9 rounded-md border px-3 text-sm" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="deactivated">Deactivated</option>
          </select>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last session</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell><Link className="font-medium hover:underline" to={`/app/admin/users/${account.id}/`}>{account.name}</Link></TableCell>
                    <TableCell className="max-w-48 truncate">{account.email}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {account.roles.map((item) => <Badge key={item} variant="outline">{item}</Badge>)}
                      </div>
                    </TableCell>
                    <TableCell className="capitalize">{account.emailVerified ? account.status : `${account.status} · pending verification`}</TableCell>
                    <TableCell>{account.lastSessionAt ? new Date(account.lastSessionAt).toLocaleString() : "—"}</TableCell>
                    <TableCell>{new Date(account.createdAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        {showInvite ? <Card>
          <CardContent className="space-y-4">
            <h2 className="text-lg font-medium">Invite user</h2>
            <form className="grid gap-3 md:grid-cols-[1fr_12rem_auto] md:items-end" onSubmit={(event) => void invite(event)}>
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-role">Role</Label>
                <select id="invite-role" className="h-9 w-full rounded-md border px-3 text-sm" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
                  {roleOptions.map((item) => <option key={item.id} value={item.key}>{item.name}</option>)}
                </select>
              </div>
              <Button type="submit">Send invitation</Button>
            </form>
            {message ? <p className="text-sm">{message}</p> : null}
            <ul className="space-y-2 text-sm">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                  <span>{invitation.email}</span>
                  <span className="text-muted-foreground">{invitation.status} · {invitation.deliveryStatus}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card> : null}
      </AppPageContainer>
    </>
  );
}
