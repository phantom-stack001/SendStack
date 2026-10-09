import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type RoleOption = {
  id: string;
  key: string;
  name: string;
  description: string;
};

export function CreateUserPage() {
  const navigate = useNavigate();
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [status, setStatus] = useState<"active" | "suspended">("active");
  const [showPassword, setShowPassword] = useState(false);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/roles", { credentials: "include" })
      .then(async (response) => {
        const payload = await response.json();
        if (cancelled || !response.ok) return;
        const options = (payload.roles ?? []) as RoleOption[];
        setRoles(options);
        const defaultRole = options.find((role) => role.key === "user") ?? options[0];
        if (defaultRole) setRoleId(defaultRole.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!roleId) return;
    let cancelled = false;
    fetch(`/api/admin/roles/${roleId}`, { credentials: "include" })
      .then(async (response) => {
        const payload = await response.json();
        if (!cancelled && response.ok) setPermissions(payload.role?.permissions ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  const selected = roles.find((role) => role.id === roleId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          confirmPassword,
          roleIds: [roleId],
          status,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "The account could not be created.");
        return;
      }
      navigate(`/app/admin/users/${payload.user.id}/`, { state: { created: true } });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageMeta title="Create User | SendStack" description="Create a new account and configure its access." canonicalPath="/app/admin/users/new/" />
      <AppPageContainer>
        <PageHeader
          title="Create User"
          description="Create a new account and configure its access."
          actions={<Button variant="outline" asChild><Link to="/app/admin/users/">Back</Link></Button>}
        />
        <Card>
          <CardContent>
            <form className="space-y-4" onSubmit={(event) => void submit(event)}>
              {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
              <div className="space-y-2">
                <Label htmlFor="create-name">Full name</Label>
                <Input id="create-name" value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-email">Email address</Label>
                <Input id="create-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="off" />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="create-password">Initial password</Label>
                  <Input id="create-password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="create-confirm">Confirm password</Label>
                  <Input id="create-confirm" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required autoComplete="new-password" />
                </div>
              </div>
              <Button type="button" variant="outline" onClick={() => setShowPassword((current) => !current)}>
                {showPassword ? "Hide password" : "Show password"}
              </Button>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="create-role">Assign role</Label>
                  <select id="create-role" className="native-select" value={roleId} onChange={(event) => setRoleId(event.target.value)} required>
                    {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                  </select>
                  {selected ? <p className="text-sm text-muted-foreground">{selected.description}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="create-status">Account status</Label>
                  <select id="create-status" className="native-select" value={status} onChange={(event) => setStatus(event.target.value as "active" | "suspended")}>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Effective permissions</p>
                <div className="flex flex-wrap gap-1">
                  {permissions.map((permission) => <Badge key={permission} variant="outline">{permission}</Badge>)}
                </div>
                <p className="text-sm text-muted-foreground">The address is not marked verified. The person must verify their email before signing in.</p>
              </div>
              <Button type="submit" disabled={submitting || !roleId}>{submitting ? "Creating…" : "Create user"}</Button>
            </form>
          </CardContent>
        </Card>
      </AppPageContainer>
    </>
  );
}
