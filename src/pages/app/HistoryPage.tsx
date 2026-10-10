import { useEffect, useState } from "react";

import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthorization } from "@/lib/authorization";
import { listIndividualSends, type IndividualSend } from "@/lib/mail-api";

const STATUS_LABEL: Record<IndividualSend["status"], string> = {
  pending: "Preparing",
  submitting: "Submitting",
  accepted: "Accepted by server",
  rejected: "Rejected",
  failed: "Not submitted",
  uncertain: "Uncertain",
};

export function HistoryPage() {
  const { can, loaded } = useAuthorization();
  const allowed = can("mailbox.send");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<IndividualSend[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded || !allowed) return;
    let cancelled = false;
    listIndividualSends(page)
      .then((result) => {
        if (cancelled) return;
        setRows(result.submissions);
        setTotalPages(result.pagination.totalPages);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Sending history could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, loaded, page]);

  return (
    <>
      <PageMeta title="Sending History | SendStack" description="Individual email submissions." canonicalPath="/app/history/" />
      <AppPageContainer>
        <PageHeader
          title="Sending history"
          description="Individual messages submitted through the outgoing mail server. Acceptance is not the same as inbox delivery. Campaign simulation results are not listed here."
        />
        {!loaded ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {loaded && !allowed ? (
          <p className="text-sm text-muted-foreground">You do not have permission to view individual send records.</p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="space-y-2 rounded-lg border border-border p-4">
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium">{row.subject}</p>
                  <p className="truncate text-sm text-muted-foreground">{row.to.join(", ")}</p>
                </div>
                <Badge variant={row.status === "accepted" ? "secondary" : "outline"}>{STATUS_LABEL[row.status]}</Badge>
              </div>
              <p className="text-sm wrap-break-word text-muted-foreground">{row.note}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(row.createdAt).toLocaleString()} · Sent copy: {row.sentCopyStatus ?? "not recorded"}
                {row.bccCount > 0 ? ` · Bcc: ${row.bccCount}` : ""}
              </p>
            </li>
          ))}
        </ul>
        {loaded && allowed && rows.length === 0 && !error ? (
          <p className="text-sm text-muted-foreground">No individual messages have been submitted yet.</p>
        ) : null}
        {totalPages > 1 ? (
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
            <Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
              Next
            </Button>
          </div>
        ) : null}
      </AppPageContainer>
    </>
  );
}
