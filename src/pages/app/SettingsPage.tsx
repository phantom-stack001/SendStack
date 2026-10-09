import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import {
  getMailStatus,
  MailApiError,
  sendMailTest,
  submissionFromError,
  testMailConnection,
  type ConnectionState,
  type MailStatus,
  type MailSubmission,
} from "@/lib/mail-api";

function formatWhen(value: string | null) {
  if (!value) return "Not tested yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not tested yet";
  return date.toLocaleString();
}

function connectionLabel(status: ConnectionState) {
  if (status === "connected") return "Connected";
  if (status === "failed") return "Failed";
  if (status === "not_configured") return "Not configured";
  return "Not tested";
}

function connectionVariant(status: ConnectionState): "default" | "destructive" | "outline" {
  if (status === "connected") return "default";
  if (status === "failed") return "destructive";
  return "outline";
}

function submissionLabel(submission: MailSubmission) {
  if (submission.smtpAccepted) return "Accepted by outgoing server";
  if (submission.status === "rejected") return "Rejected";
  if (submission.status === "pending") return "In progress";
  return "Not accepted";
}

export function SettingsPage() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [restricted, setRestricted] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [submission, setSubmission] = useState<MailSubmission | null>(null);
  const [duplicate, setDuplicate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMailStatus()
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        setSubmission(result.latestSubmission);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof MailApiError && error.status === 403) {
          setRestricted(true);
        } else {
          setLoadError(error instanceof MailApiError ? error.message : "Could not load email settings.");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runConnectionTest() {
    setTesting(true);
    setTestError(null);
    try {
      const result = await testMailConnection();
      setStatus(result);
    } catch (error) {
      setTestError(error instanceof MailApiError ? error.message : "Could not test the connection.");
    } finally {
      setTesting(false);
    }
  }

  function openConfirm() {
    setIdempotencyKey((current) => current ?? crypto.randomUUID());
    setConfirmOpen(true);
  }

  async function submitTest() {
    if (!idempotencyKey) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await sendMailTest({
        subject: subject.trim(),
        text: text.trim(),
        confirm: true,
        idempotencyKey,
      });
      setSubmission(result.submission);
      setDuplicate(result.duplicate);
      setIdempotencyKey(null);
      setAcknowledged(false);
      setConfirmOpen(false);
    } catch (error) {
      if (error instanceof MailApiError) {
        const recorded = submissionFromError(error);
        if (recorded) setSubmission(recorded);
        setSendError(error.message);
        if (error.status !== 409) {
          setIdempotencyKey(null);
          setAcknowledged(false);
          setConfirmOpen(false);
        }
      } else {
        setSendError(
          "The request did not finish. Confirm again to retry this same test. If it already went through, the same request will not send a second message.",
        );
      }
    } finally {
      setSending(false);
    }
  }

  const canSend =
    Boolean(status?.configured && status.testRecipient) &&
    acknowledged &&
    subject.trim().length > 0 &&
    text.trim().length > 0 &&
    !sending;

  return (
    <>
      <PageMeta
        title="Settings | SendStack"
        description="Email account connection and a controlled test message."
        canonicalPath="/app/settings/"
      />
      <AppPageContainer>
        <PageHeader
          title="Settings"
          description="Email account connection and one controlled test message."
          notice="Campaign queues stay simulation-only. This page does not send campaigns."
        />

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : restricted ? (
          <Card>
            <CardContent className="text-sm text-muted-foreground">
              Mailbox administration is limited to the super admin.
            </CardContent>
          </Card>
        ) : loadError ? (
          <Card>
            <CardContent className="text-sm text-destructive">{loadError}</CardContent>
          </Card>
        ) : status ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Email account</CardTitle>
                <CardDescription>Connection status for the configured mailbox.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="space-y-1">
                  <p className="text-muted-foreground">Email account</p>
                  <p className="break-all">{status.accountEmail ?? "Not configured"}</p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="min-w-0 wrap-break-word">Outgoing mail server</p>
                  <Badge variant={connectionVariant(status.outgoing.status)}>
                    {connectionLabel(status.outgoing.status)}
                  </Badge>
                </div>
                {status.outgoing.error ? (
                  <p className="text-destructive">{status.outgoing.error}</p>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="min-w-0 wrap-break-word">Incoming mail server</p>
                  <Badge variant={connectionVariant(status.incoming.status)}>
                    {connectionLabel(status.incoming.status)}
                  </Badge>
                </div>
                {status.incoming.error ? (
                  <p className="text-destructive">{status.incoming.error}</p>
                ) : null}
                <div className="space-y-1">
                  <p className="text-muted-foreground">Last connection test</p>
                  <p>{formatWhen(status.lastCheckedAt)}</p>
                </div>
                {testError ? <p className="text-destructive">{testError}</p> : null}
                <Button type="button" onClick={() => void runConnectionTest()} disabled={testing || !status.configured}>
                  {testing ? "Testing…" : "Test connection"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Test message</CardTitle>
                <CardDescription>
                  Sends one message from the configured mailbox to the authorized test recipient.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {status.configured && status.testRecipient ? (
                  <form
                    className="space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (canSend) openConfirm();
                    }}
                  >
                    <div className="space-y-1 text-sm">
                      <p className="text-muted-foreground">From</p>
                      <p>{status.accountEmail}</p>
                    </div>
                    <div className="space-y-1 text-sm">
                      <p className="text-muted-foreground">Authorized test recipient</p>
                      <p>{status.testRecipient}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="test-subject">Subject</Label>
                      <Input
                        id="test-subject"
                        value={subject}
                        maxLength={200}
                        onChange={(event) => {
                          setSubject(event.target.value);
                          setIdempotencyKey(null);
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="test-body">Message</Label>
                      <Textarea
                        id="test-body"
                        value={text}
                        className="min-h-32"
                        maxLength={20000}
                        onChange={(event) => {
                          setText(event.target.value);
                          setIdempotencyKey(null);
                        }}
                      />
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-primary"
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.target.checked)}
                      />
                      <span>
                        I confirm this sends one message to {status.testRecipient} and does not start a campaign.
                      </span>
                    </label>
                    {sendError ? (
                      <p className="text-sm text-destructive" role="alert">
                        {sendError}
                      </p>
                    ) : null}
                    <Button type="submit" disabled={!canSend}>
                      {sending ? "Sending…" : "Review test message"}
                    </Button>
                  </form>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Email account is not configured on the server.
                  </p>
                )}
              </CardContent>
            </Card>

            {submission ? (
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Last test submission</CardTitle>
                  <CardDescription>{formatWhen(submission.createdAt)}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm" role="status">
                  <Badge variant={submission.smtpAccepted ? "default" : "destructive"}>
                    {submissionLabel(submission)}
                  </Badge>
                  {duplicate ? <p>This request was already submitted. No additional message was sent.</p> : null}
                  <p>{submission.note}</p>
                  <p>
                    From {submission.from} to {submission.to}
                  </p>
                  <p>Subject: {submission.subject}</p>
                  {submission.messageId ? <p>Message ID: {submission.messageId}</p> : null}
                  {submission.errorMessage && !submission.smtpAccepted ? (
                    <p className="text-destructive">{submission.errorMessage}</p>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}
      </AppPageContainer>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send one test message?</AlertDialogTitle>
            <AlertDialogDescription>
              This sends a single plain-text and HTML message from {status?.accountEmail} to{" "}
              {status?.testRecipient}. Subject: {subject.trim() || "(empty)"}. Acceptance by the outgoing
              server does not confirm inbox delivery. Campaign queues are not used.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={sending}
              onClick={(event) => {
                event.preventDefault();
                void submitTest();
              }}
            >
              {sending ? "Sending…" : "Send one test message"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
