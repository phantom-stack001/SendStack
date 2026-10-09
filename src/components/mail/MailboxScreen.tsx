import { Inbox, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { FolderNav } from "@/components/mail/FolderNav";
import { MessageList } from "@/components/mail/MessageList";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { listInbox, listMailbox, listSent, MailApiError, type MailMessageList } from "@/lib/mail-api";

export function MailboxScreen({ mode }: { mode: "inbox" | "sent" }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const folderQuery = searchParams.get("folder");
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const [listing, setListing] = useState<MailMessageList | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restricted, setRestricted] = useState(false);
  const requestKey = `${mode}:${folderQuery ?? ""}:${page}`;
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    const messages =
      mode === "sent"
        ? listSent(page)
        : folderQuery
          ? listMailbox(folderQuery, page)
          : listInbox(page);

    messages
      .then((messageResult) => {
        if (cancelled) return;
        setListing(messageResult);
        setError(null);
        setRestricted(false);
        setLoadedKey(requestKey);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof MailApiError && err.status === 403) {
          setRestricted(true);
          setError(null);
        } else {
          setRestricted(false);
          setError(err instanceof MailApiError ? err.message : "Could not load mailbox.");
        }
        setLoadedKey(requestKey);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, folderQuery, page, requestKey]);

  const viewingOtherFolder = mode === "inbox" && Boolean(folderQuery);
  const title = mode === "sent" ? "Sent" : viewingOtherFolder ? (listing?.folder.name ?? "Mailbox") : "Inbox";
  const description =
    mode === "sent"
      ? "Messages sent from your mailbox."
      : viewingOtherFolder
        ? "Messages in this folder."
        : "Your received messages.";

  function changePage(next: number) {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(next));
    setSearchParams(params);
  }

  return (
    <>
      <PageMeta
        title={`${title} | SendStack`}
        description={description}
        canonicalPath={mode === "sent" ? "/app/sent/" : "/app/inbox/"}
      />
      <AppPageContainer className="max-w-[90rem]">
        <PageHeader title={title} description={description} />

        {restricted ? (
          <Card>
            <CardContent className="text-sm text-muted-foreground">
              Mailbox access is limited to the super admin.
            </CardContent>
          </Card>
        ) : (
          <div className="flex w-full min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
            {loading && !listing ? (
              <Skeleton className="h-9 w-full lg:h-40 lg:w-44" />
            ) : listing ? (
              <FolderNav folders={listing.folders.filter((folder) => folder.selectable)} activePath={listing.folder.path} />
            ) : null}

            <div className="min-w-0 flex-1">
              {loading ? (
                <div className="space-y-3">
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
              ) : error ? (
                <Card>
                  <CardContent className="text-sm text-destructive">{error}</CardContent>
                </Card>
              ) : listing && listing.messages.length === 0 ? (
                <EmptyState
                  icon={mode === "sent" ? Send : Inbox}
                  title={mode === "sent" ? "No sent messages" : "No messages"}
                  description={
                    mode === "sent"
                      ? "Messages you send will appear here."
                      : "This folder is empty."
                  }
                />
              ) : listing ? (
                <MessageList
                  mode={mode}
                  folderPath={listing.folder.path}
                  messages={listing.messages}
                  pagination={listing.pagination}
                  onPage={changePage}
                />
              ) : null}
            </div>
          </div>
        )}
      </AppPageContainer>
    </>
  );
}
