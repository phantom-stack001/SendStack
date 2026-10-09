import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { ContactsTable } from "@/components/recipients/ContactsTable";
import { RecipientsNav } from "@/components/recipients/RecipientsNav";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchListDetail,
  removeContactsFromList,
  type Contact,
  type ContactList,
} from "@/lib/recipients-api";

export function ContactListDetailsPage() {
  const { listId } = useParams<{ listId: string }>();
  const [list, setList] = useState<ContactList | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    if (!listId) return Promise.resolve();
    return fetchListDetail(listId).then((res) => {
      setList(res.list);
      setContacts(res.contacts);
    });
  }, [listId]);

  useEffect(() => {
    if (!listId) return;
    let cancelled = false;
    refresh()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listId, refresh]);

  const removeSelected = async () => {
    if (!listId || selectedIds.size === 0) return;
    await removeContactsFromList(listId, Array.from(selectedIds));
    setSelectedIds(new Set());
    setLoading(true);
    await refresh();
    setLoading(false);
  };

  if (!listId) return null;

  return (
    <>
      <PageMeta title="List details | SendStack" description="Contact list." canonicalPath={`/app/recipients/lists/${listId}/`} />
      <AppPageContainer>
        <PageHeader
          title={list?.name ?? "List"}
          description={list?.description || "Contacts in this list."}
        />
        <RecipientsNav />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link to="/app/recipients/lists/">Back to lists</Link></Button>
          {selectedIds.size > 0 ? (
            <Button variant="destructive" onClick={() => void removeSelected()}>Remove selected</Button>
          ) : null}
        </div>
        <Card>
          <CardContent className="pt-6">
            {loading ? <Skeleton className="h-40 w-full" /> : (
              <ContactsTable
                contacts={contacts}
                selectedIds={selectedIds}
                onToggleSelect={(id) => setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
                onToggleSelectAll={() => {
                  if (contacts.every((c) => selectedIds.has(c.id))) setSelectedIds(new Set());
                  else setSelectedIds(new Set(contacts.map((c) => c.id)));
                }}
                allSelected={contacts.length > 0 && contacts.every((c) => selectedIds.has(c.id))}
                showActions={false}
              />
            )}
          </CardContent>
        </Card>
      </AppPageContainer>
    </>
  );
}
