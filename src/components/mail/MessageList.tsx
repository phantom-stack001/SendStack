import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { formatMailDate } from "@/lib/mail-format";
import type { MailMessageSummary, MailPagination } from "@/lib/mail-api";
import { cn } from "@/lib/utils";

export function MessageList({
  mode,
  folderPath,
  messages,
  pagination,
  onPage,
}: {
  mode: "inbox" | "sent";
  folderPath: string;
  messages: MailMessageSummary[];
  pagination: MailPagination;
  onPage: (page: number) => void;
}) {
  const addressLabel = mode === "sent" ? "To" : "From";
  const base = mode === "sent" ? "/app/sent" : "/app/inbox";

  return (
    <div className="w-full min-w-0 overflow-hidden rounded-xl border bg-card">
      <div className="hidden border-b px-4 py-2 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_9rem] sm:gap-3">
        <span>{addressLabel}</span>
        <span>Subject</span>
        <span className="text-right">Date</span>
      </div>
      <ul className="divide-y">
        {messages.map((message) => {
          const href = `${base}/${message.uid}/?folder=${encodeURIComponent(folderPath)}`;
          const address = mode === "sent" ? message.to : message.from;
          return (
            <li key={message.uid}>
              <Link
                to={href}
                className={cn(
                  "grid min-w-0 gap-1 px-4 py-3 hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_9rem] sm:items-start sm:gap-3",
                  !message.seen && "bg-muted/30",
                )}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <span
                    className={cn("size-2 shrink-0 rounded-full", message.seen ? "bg-transparent" : "bg-primary")}
                    aria-hidden="true"
                  />
                  <span className="truncate" title={address}>
                    <span className="text-muted-foreground sm:hidden">{addressLabel} </span>
                    {address}
                  </span>
                  {!message.seen ? <span className="sr-only">Unread</span> : null}
                </span>
                <span className="min-w-0 sm:col-start-2">
                  <span className={cn("block truncate text-sm", !message.seen && "font-medium")} title={message.subject}>
                    {message.subject}
                  </span>
                  {message.preview ? (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{message.preview}</span>
                  ) : null}
                </span>
                <time className="text-xs text-muted-foreground sm:text-right" dateTime={message.date ?? undefined}>
                  {formatMailDate(message.date)}
                </time>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          Page {pagination.page} of {pagination.totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => onPage(pagination.page - 1)}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => onPage(pagination.page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
