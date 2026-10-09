import { useEffect, useState } from "react";

import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type AuditEvent = {
  id: string;
  action: string;
  actorUserId: string | null;
  targetUserId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/audit", { credentials: "include" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load the audit log.");
        setEvents(payload.events);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the audit log."));
  }, []);

  return (
    <>
      <PageMeta title="Audit log | SendStack" description="Administrative actions." canonicalPath="/app/admin/audit/" />
      <AppPageContainer className="max-w-none">
        <PageHeader title="Audit log" description="Sensitive account and role changes recorded by SendStack." />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-muted-foreground">No administrative events yet.</TableCell></TableRow>
                ) : null}
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>{new Date(event.createdAt).toLocaleString()}</TableCell>
                    <TableCell>{event.action}</TableCell>
                    <TableCell className="max-w-32 truncate">{event.actorUserId ?? "—"}</TableCell>
                    <TableCell className="max-w-32 truncate">{event.targetUserId ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </AppPageContainer>
    </>
  );
}
