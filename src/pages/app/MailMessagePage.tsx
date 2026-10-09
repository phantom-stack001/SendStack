import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";

import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMailDate } from "@/lib/mail-format";
import { getMailMessage, MailApiError, type MailMessage } from "@/lib/mail-api";
import { mailMessageSrcDoc } from "@/lib/mail-document";

export function MailMessagePage() {
  const { uid } = useParams<{ uid: string }>();
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const folder = searchParams.get("folder") ?? "";
  const missing = !uid || !folder;
  const requestKey = `${uid ?? ""}:${folder}`;
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = !missing && loadedKey !== requestKey;

  useEffect(() => {
    if (!uid || !folder) return;
    let cancelled = false;
    getMailMessage(uid, folder)
      .then((result) => {
        if (cancelled) return;
        setMessage(result.message);
        setError(null);
        setLoadedKey(requestKey);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMessage(null);
        setError(err instanceof MailApiError ? err.message : "Could not open this message.");
        setLoadedKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [uid, folder, requestKey]);

  const back = pathname.startsWith("/app/sent/")
    ? "/app/sent/"
    : folder && folder.toUpperCase() !== "INBOX"
      ? `/app/inbox/?folder=${encodeURIComponent(folder)}`
      : "/app/inbox/";

  return (
    <>
      <PageMeta
        title={message ? `${message.subject} | SendStack` : "Message | SendStack"}
        description="Read a mailbox message."
        canonicalPath={pathname}
      />
      <AppPageContainer className="max-w-[90rem]">
        <PageHeader
          title={message?.subject ?? "Message"}
          actions={<Button variant="outline" asChild><Link to={back}>Back</Link></Button>}
        />

        {missing ? (
          <Card>
            <CardContent className="text-sm text-destructive">That message could not be found.</CardContent>
          </Card>
        ) : loading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : error ? (
          <Card>
            <CardContent className="text-sm text-destructive">{error}</CardContent>
          </Card>
        ) : message ? (
          <Card>
            <CardContent className="space-y-4">
              <dl className="grid gap-2 text-sm sm:grid-cols-[5rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground">From</dt>
                <dd className="min-w-0 break-words">{message.from}</dd>
                <dt className="text-muted-foreground">To</dt>
                <dd className="min-w-0 break-words">{message.to}</dd>
                <dt className="text-muted-foreground">Date</dt>
                <dd>{formatMailDate(message.date) || "Unknown date"}</dd>
              </dl>
              {message.attachments.length > 0 ? (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {message.attachments.map((attachment) => (
                    <li key={attachment.name} className="break-all">Attachment: {attachment.name}</li>
                  ))}
                </ul>
              ) : null}
              {message.bodyLimited ? (
                <p className="text-sm text-muted-foreground">
                  This message was too large to display in full.
                </p>
              ) : null}
              {message.html ? (
                <div className="max-w-full overflow-x-auto">
                  <iframe
                    title="Message content"
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    referrerPolicy="no-referrer"
                    srcDoc={mailMessageSrcDoc(message.html)}
                    className="min-h-64 w-full max-w-full rounded-md border border-border bg-white"
                  />
                </div>
              ) : (
                <pre className="wrap-break-word whitespace-pre-wrap font-sans text-sm">{message.text}</pre>
              )}
            </CardContent>
          </Card>
        ) : null}
      </AppPageContainer>
    </>
  );
}
