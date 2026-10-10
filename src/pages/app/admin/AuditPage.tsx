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
      <AppPageContainer className="max-w-[90rem]">
        <PageHeader title="Audit log" description="Sensitive account and role changes recorded by SendStack." />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y md:hidden">
              {events.length === 0 ? <li className="px-4 py-6 text-sm text-muted-foreground">No administrative events yet.</li> : null}
              {events.map((event) => (
                <li key={event.id} className="space-y-1 px-4 py-3 text-sm">
                  <p className="font-medium wrap-break-word">{event.action}</p>
                  {typeof event.metadata.reason === "string" ? <p className="wrap-break-word text-muted-foreground">{event.metadata.reason}</p> : null}
                  <p className="text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</p>
                  <p className="break-all text-muted-foreground">Actor {event.actorUserId ?? "—"}</p>
                  <p className="break-all text-muted-foreground">Target {event.targetUserId ?? "—"}</p>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
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
                    <TableCell className="max-w-32 truncate" title={event.actorUserId ?? undefined}>{event.actorUserId ?? "—"}</TableCell>
                    <TableCell className="max-w-32 truncate" title={event.targetUserId ?? undefined}>{event.targetUserId ?? "—"}</TableCell>
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
