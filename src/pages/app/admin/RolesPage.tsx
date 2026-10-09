import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type RoleSummary = {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissionCount: number;
  userCount: number;
};

type PermissionItem = { key: string; category: string; description: string };

export function RolesPage() {
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/roles", { credentials: "include" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load roles.");
        setRoles(payload.roles);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load roles."));
  }, []);

  return (
    <>
      <PageMeta title="Roles | SendStack" description="Manage roles and permissions." canonicalPath="/app/admin/roles/" />
      <AppPageContainer className="max-w-[90rem]">
        <PageHeader
          title="Roles"
          description="System roles are protected. Custom roles can be created from a copy of the permission list."
          actions={<Button asChild><Link to="/app/admin/roles/new/">Create role</Link></Button>}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y md:hidden">
              {roles.map((role) => (
                <li key={role.id} className="space-y-1 px-4 py-3">
                  <Link className="font-medium wrap-break-word hover:underline" to={`/app/admin/roles/${role.id}/`}>{role.name}</Link>
                  <p className="text-sm break-all text-muted-foreground">{role.key}</p>
                  <p className="text-sm text-muted-foreground">{role.userCount} users · {role.permissionCount} permissions</p>
                  {role.isSystem ? <Badge variant="outline">System</Badge> : <Badge>Custom</Badge>}
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Users</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead>Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.map((role) => (
                  <TableRow key={role.id}>
                    <TableCell><Link className="font-medium hover:underline" to={`/app/admin/roles/${role.id}/`}>{role.name}</Link></TableCell>
                    <TableCell>{role.key}</TableCell>
                    <TableCell>{role.userCount}</TableCell>
                    <TableCell>{role.permissionCount}</TableCell>
                    <TableCell>{role.isSystem ? <Badge variant="outline">System</Badge> : <Badge>Custom</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>
      </AppPageContainer>
    </>
  );
}

export function RoleDetailsPage() {
  const { roleId } = useParams();
  const navigate = useNavigate();
  const creating = !roleId || roleId === "new";
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<PermissionItem[]>([]);
  const [isSystem, setIsSystem] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/permissions", { credentials: "include" })
      .then((response) => response.json())
      .then((payload) => setCatalog(payload.permissions ?? []));
    if (!creating && roleId) {
      fetch(`/api/admin/roles/${roleId}`, { credentials: "include" })
        .then((response) => response.json())
        .then((payload) => {
          if (!payload.role) return;
          setName(payload.role.name);
          setKey(payload.role.key);
          setDescription(payload.role.description);
          setSelected(payload.role.permissions);
          setIsSystem(payload.role.isSystem);
        });
    }
  }, [creating, roleId]);

  const groups = catalog.reduce<Record<string, PermissionItem[]>>((map, item) => {
    map[item.category] ??= [];
    map[item.category]?.push(item);
    return map;
  }, {});

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const response = await fetch(creating ? "/api/admin/roles" : `/api/admin/roles/${roleId}`, {
      method: creating ? "POST" : "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, name, description, permissions: selected }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Could not save the role.");
      return;
    }
    navigate(`/app/admin/roles/${payload.role.id}/`);
  }

  async function remove() {
    if (!roleId) return;
    const response = await fetch(`/api/admin/roles/${roleId}`, { method: "DELETE", credentials: "include" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Could not delete the role.");
      return;
    }
    navigate("/app/admin/roles/");
  }

  return (
    <>
      <PageMeta title="Role | SendStack" description="Edit a role." canonicalPath="/app/admin/roles/" />
      <AppPageContainer>
        <PageHeader title={creating ? "Create role" : name || "Role"} description="Sensitive permissions stay limited to the super-admin role." />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="role-name">Name</Label>
              <Input id="role-name" value={name} onChange={(event) => setName(event.target.value)} disabled={isSystem} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role-key">Key</Label>
              <Input id="role-key" value={key} onChange={(event) => setKey(event.target.value)} disabled={!creating} required />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="role-description">Description</Label>
            <Input id="role-description" value={description} onChange={(event) => setDescription(event.target.value)} disabled={isSystem} />
          </div>
          {Object.entries(groups).map(([category, items]) => (
            <fieldset key={category} className="space-y-2 rounded-xl border p-4">
              <legend className="px-1 text-sm font-medium">{category}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {items.map((item) => (
                  <label key={item.key} className="flex min-h-11 items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-5 shrink-0"
                      disabled={isSystem}
                      checked={selected.includes(item.key)}
                      onChange={(event) => {
                        setSelected((current) => event.target.checked ? [...current, item.key] : current.filter((key) => key !== item.key));
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block capitalize">{item.key.split(".")[1]}</span>
                      <span className="wrap-break-word text-muted-foreground">{item.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {isSystem ? <p className="text-sm text-muted-foreground">System roles cannot be changed or deleted.</p> : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" className="w-full sm:w-auto">{creating ? "Create role" : "Save role"}</Button>
              {!creating ? <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => void remove()}>Delete role</Button> : null}
            </div>
          )}
        </form>
      </AppPageContainer>
    </>
  );
}
