import { useCallback, useEffect, useState } from "react";

import { RecipientsNav } from "@/components/recipients/RecipientsNav";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createSuppression,
  fetchSuppressions,
  type Suppression,
  type SuppressionReason,
} from "@/lib/recipients-api";

const REASONS: SuppressionReason[] = ["unsubscribed", "hard_bounce", "complaint", "manual_block"];

export function SuppressionsPage() {
  const [items, setItems] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("manual_block");

  const load = useCallback(() => {
    let cancelled = false;
    fetchSuppressions({ q: q.trim() || undefined })
      .then((res) => {
        if (!cancelled) {
          setItems(res.suppressions);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q]);

  useEffect(() => load(), [load]);

  return (
    <>
      <PageMeta title="Suppressions | SendStack" description="Suppression list." canonicalPath="/app/recipients/suppressions/" />
      <AppPageContainer>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <PageHeader title="Suppressions" description="Emails blocked from future marketing sends." />
          <Button onClick={() => setDialogOpen(true)}>Add suppression</Button>
        </div>
        <RecipientsNav />
        <div className="max-w-md space-y-1.5">
          <Label htmlFor="sup-search">Search email</Label>
          <Input id="sup-search" value={q} onChange={(e) => { setLoading(true); setQ(e.target.value); }} placeholder="name@example.com" />
        </div>
        <Card>
          <CardContent className="pt-6">
            {loading ? <Skeleton className="h-40 w-full" /> : items.length === 0 ? (
              <EmptyState title="No suppressions" description="Manual blocks and unsubscribe events appear here." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.email}</TableCell>
                      <TableCell><Badge variant="secondary">{item.reason}</Badge></TableCell>
                      <TableCell>{new Date(item.createdAt).toLocaleDateString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </AppPageContainer>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add suppression</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <select className="flex h-9 w-full rounded-md border border-input px-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value as SuppressionReason)}>
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => void createSuppression({ email, reason }).then(() => { setDialogOpen(false); setEmail(""); void load(); })}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
