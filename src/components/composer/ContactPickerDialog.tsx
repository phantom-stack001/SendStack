import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  fetchContacts,
  fetchSuppressions,
  type Contact,
  type SubscriptionStatus,
} from "@/lib/recipients-api";

type ContactPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (email: string) => void;
};

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  pending: "Pending",
  unknown: "Unknown consent",
};

export function ContactPickerDialog({ open, onOpenChange, onSelect }: ContactPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [suppressed, setSuppressed] = useState<Set<string>>(new Set());
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      Promise.all([
        fetchContacts({ q: query, page, limit: 8, sort: "email_asc" }),
        fetchSuppressions({ q: query, page: 1, limit: 25 }),
      ])
        .then(([contactPage, suppressionPage]) => {
          setContacts(contactPage.contacts);
          setTotalPages(contactPage.pagination.totalPages);
          setSuppressed(new Set(suppressionPage.suppressions.map((row) => row.email)));
        })
        .catch(() => setError("Contacts could not be loaded."))
        .finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [open, page, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a contact</DialogTitle>
          <DialogDescription>
            Selecting a contact does not change their consent. Sending still checks suppressions.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          placeholder="Search name or email"
          aria-label="Search contacts"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <ul className="space-y-2">
          {contacts.map((contact) => {
            const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
            const blocked =
              suppressed.has(contact.email) || contact.subscriptionStatus !== "subscribed";
            return (
              <li key={contact.id} className="rounded-md border border-border p-3">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{name || contact.email}</p>
                    <p className="truncate text-sm text-muted-foreground">{contact.email}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Badge variant="outline">{STATUS_LABEL[contact.subscriptionStatus]}</Badge>
                      {suppressed.has(contact.email) ? <Badge variant="destructive">Suppressed</Badge> : null}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={blocked}
                    onClick={() => {
                      onSelect(contact.email);
                      onOpenChange(false);
                    }}
                  >
                    {blocked ? "Not eligible" : "Add"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {loading ? <p className="text-sm text-muted-foreground">Loading contacts…</p> : null}
        {!loading && contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts match this search.</p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
