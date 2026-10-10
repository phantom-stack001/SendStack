import { generateHTML } from "@tiptap/html";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBlocker, useNavigate } from "react-router-dom";

import { ComposerHeader } from "@/components/composer/ComposerHeader";
import { ContactPickerDialog } from "@/components/composer/ContactPickerDialog";
import { EmailPreview } from "@/components/composer/EmailPreview";
import { RecipientField } from "@/components/composer/RecipientField";
import { RichTextEditor } from "@/components/composer/RichTextEditor";
import { SendReviewDialog } from "@/components/composer/SendReviewDialog";
import { SenderFields } from "@/components/composer/SenderFields";
import { SubjectField } from "@/components/composer/SubjectField";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DraftApiError, type Draft, type DraftInput } from "@/lib/drafts-api";
import { buildFormStateFromDraft, type ComposerFormState } from "@/lib/composer-form";
import { isValidSenderEmail } from "@/lib/email-content";
import { useAuthorization } from "@/lib/authorization";
import { getMailStatus, MailApiError, sendIndividualEmail, type IndividualSend } from "@/lib/mail-api";
import { addRecipients, recipientFieldError, type RecipientFieldName } from "@/lib/recipient-input";
import { composerExtensions } from "@/lib/tiptap-extensions";

function submissionFromSend(error: MailApiError): IndividualSend | null {
  const details = error.details;
  if (!details || typeof details !== "object" || !("submission" in details)) return null;
  return details.submission as IndividualSend;
}

function statesEqual(a: ComposerFormState, b: ComposerFormState) {
  return (
    a.senderName === b.senderName &&
    a.senderEmail === b.senderEmail &&
    a.subject === b.subject &&
    JSON.stringify(a.contentJson) === JSON.stringify(b.contentJson)
  );
}

type EmailComposerProps = {
  draftId?: string;
  initialForm: ComposerFormState;
  initialSavedAt: string | null;
  onSave: (input: DraftInput, existingId?: string) => Promise<Draft>;
};

export function EmailComposer({
  draftId,
  initialForm,
  initialSavedAt,
  onSave,
}: EmailComposerProps) {
  const navigate = useNavigate();
  const [form, setForm] = useState(initialForm);
  const [savedSnapshot, setSavedSnapshot] = useState(initialForm);
  const [currentDraftId, setCurrentDraftId] = useState<string | undefined>(draftId);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(initialSavedAt);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pickerField, setPickerField] = useState<RecipientFieldName | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [sendPhase, setSendPhase] = useState<"idle" | "sending" | "submitted" | "failed" | "uncertain">("idle");
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [authorizedSender, setAuthorizedSender] = useState<string | null>(null);
  const { can } = useAuthorization();
  const canSend = can("mailbox.send");

  useEffect(() => {
    if (!canSend) return;
    void getMailStatus()
      .then((status) => setAuthorizedSender(status.accountEmail))
      .catch(() => undefined);
  }, [canSend]);

  const dirty = !statesEqual(form, savedSnapshot);
  const sending = sendPhase === "sending";
  const blocker = useBlocker(dirty && !saving && !sending);
  const navigationBlocked = blocker.state === "blocked";

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const senderEmailError =
    form.senderEmail.trim() && !isValidSenderEmail(form.senderEmail)
      ? "Enter a valid email address."
      : null;

  const previewHtml = useMemo(
    () => generateHTML(form.contentJson, composerExtensions),
    [form.contentJson],
  );

  const handleSave = useCallback(async () => {
    if (senderEmailError) {
      setSaveError(senderEmailError);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const saved = await onSave(
        {
          senderName: form.senderName,
          senderEmail: form.senderEmail,
          subject: form.subject,
          contentJson: form.contentJson,
        },
        currentDraftId,
      );

      const snapshot = {
        ...buildFormStateFromDraft(saved),
        to: form.to,
        cc: form.cc,
        bcc: form.bcc,
      };
      setSavedSnapshot({ ...snapshot, to: [], cc: [], bcc: [] });
      setForm(snapshot);
      setSaveSuccess("Draft saved.");
      setCurrentDraftId(saved.id);
      setLastSavedAt(saved.updatedAt);

      if (!draftId) {
        navigate(`/app/compose/${saved.id}/`, { replace: true });
      }
    } catch (error) {
      setSaveError(
        error instanceof DraftApiError ? error.message : "Could not save draft",
      );
    } finally {
      setSaving(false);
    }
  }, [currentDraftId, draftId, form, navigate, onSave, senderEmailError]);

  const openReview = () => {
    const error = recipientFieldError(form) ?? senderEmailError;
    if (!form.subject.trim()) {
      setRecipientError("Add a subject before sending.");
      return;
    }
    if (error) {
      setRecipientError(error);
      return;
    }
    setRecipientError(null);
    setIdempotencyKey((current) => current ?? crypto.randomUUID());
    setReviewOpen(true);
    if (!authorizedSender) {
      void getMailStatus()
        .then((status) => setAuthorizedSender(status.accountEmail))
        .catch(() => setAuthorizedSender(null));
    }
  };

  const confirmSend = async () => {
    if (!idempotencyKey || sending) return;
    setSendPhase("sending");
    setSendMessage(null);
    try {
      const result = await sendIndividualEmail({
        senderEmail: form.senderEmail,
        to: form.to,
        cc: form.cc,
        bcc: form.bcc,
        subject: form.subject,
        contentJson: form.contentJson,
        draftId: currentDraftId ?? null,
        idempotencyKey,
        confirm: true,
      });
      const submission = result.submission;
      setSendMessage(submission.note);
      if (submission.status === "accepted") setSendPhase("submitted");
      else if (submission.status === "uncertain" || submission.status === "submitting") setSendPhase("uncertain");
      else setSendPhase("failed");
      setReviewOpen(false);
    } catch (error) {
      const submission = error instanceof MailApiError ? submissionFromSend(error) : null;
      if (submission?.status === "uncertain" || submission?.status === "submitting") {
        setSendPhase("uncertain");
        setSendMessage(submission.note);
      } else {
        setSendPhase("failed");
        setSendMessage(error instanceof MailApiError ? error.message : "The message was not sent.");
      }
      setReviewOpen(false);
    }
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
    setSaveError(null);
    setSaveSuccess(null);
  };

  const confirmLeave = () => {
    if (blocker.state === "blocked") {
      blocker.proceed();
    }
  };

  const cancelLeave = () => {
    if (blocker.state === "blocked") {
      blocker.reset();
    }
  };

  return (
    <div className="space-y-6">
      <ComposerHeader
        dirty={dirty}
        saving={saving}
        lastSavedAt={lastSavedAt}
        error={saveError}
        success={saveSuccess}
        onSave={() => void handleSave()}
        onPreview={() => setPreviewOpen(true)}
        onDiscard={handleDiscard}
        canDiscard={dirty}
        canSend={canSend && sendPhase !== "uncertain"}
        sending={sending}
        onSend={openReview}
      />
      {sendMessage ? (
        <p className={`text-sm wrap-break-word ${sendPhase === "failed" || sendPhase === "uncertain" ? "text-destructive" : "text-muted-foreground"}`}>
          {sendPhase === "sending" ? "Sending…" : sendMessage}
        </p>
      ) : null}
      {recipientError ? <p className="text-sm text-destructive wrap-break-word">{recipientError}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sender details</CardTitle>
        </CardHeader>
        <CardContent>
          <SenderFields
            senderName={form.senderName}
            senderEmail={form.senderEmail}
            onSenderNameChange={(value) =>
              setForm((current) => ({ ...current, senderName: value }))
            }
            onSenderEmailChange={(value) =>
              setForm((current) => ({ ...current, senderEmail: value }))
            }
            senderEmailError={senderEmailError}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {canSend ? (
            <div className="space-y-4">
              {(["to", "cc", "bcc"] as const).map((field) => (
                <div key={field} className="space-y-2">
                  <RecipientField
                    id={`recipient-${field}`}
                    label={field === "to" ? "To" : field === "cc" ? "Cc" : "Bcc"}
                    required={field === "to"}
                    values={form[field]}
                    disabled={sending}
                    onInvalid={setRecipientError}
                    onChange={(values) => {
                      setForm((current) => ({ ...current, [field]: values }));
                      setSendPhase("idle");
                      setIdempotencyKey(null);
                    }}
                  />
                  <button
                    type="button"
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    onClick={() => setPickerField(field)}
                  >
                    Choose a saved contact
                  </button>
                </div>
              ))}
              {authorizedSender && form.senderEmail.trim() && form.senderEmail.trim().toLowerCase() !== authorizedSender ? (
                <p className="text-sm text-destructive wrap-break-word">
                  This draft uses {form.senderEmail}, but mail can only be sent as {authorizedSender}.{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setForm((current) => ({ ...current, senderEmail: authorizedSender }))}
                  >
                    Use {authorizedSender}
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}
          <SubjectField
            subject={form.subject}
            onSubjectChange={(value) =>
              setForm((current) => ({ ...current, subject: value }))
            }
          />
          <RichTextEditor
            content={form.contentJson}
            onChange={(contentJson) =>
              setForm((current) => ({ ...current, contentJson }))
            }
          />
        </CardContent>
      </Card>

      <ContactPickerDialog
        open={pickerField !== null}
        onOpenChange={(open) => {
          if (!open) setPickerField(null);
        }}
        onSelect={(email) => {
          if (!pickerField) return;
          const { next, invalid } = addRecipients(form[pickerField], email);
          setForm((current) => ({ ...current, [pickerField]: next }));
          setRecipientError(invalid[0] ? `${invalid[0]} is not a valid email address.` : null);
        }}
      />
      <SendReviewDialog
        open={reviewOpen}
        sending={sending}
        from={form.senderName.trim() ? `${form.senderName.trim()} · ${authorizedSender ?? form.senderEmail}` : authorizedSender ?? form.senderEmail}
        to={form.to}
        cc={form.cc}
        bcc={form.bcc}
        subject={form.subject}
        bodyHtml={previewHtml}
        onCancel={() => {
          if (!sending) setReviewOpen(false);
        }}
        onConfirm={() => void confirmSend()}
      />
      <EmailPreview
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        senderName={form.senderName}
        senderEmail={form.senderEmail}
        subject={form.subject}
        bodyHtml={previewHtml}
      />

      <AlertDialog
        open={navigationBlocked}
        onOpenChange={(open) => {
          if (!open) cancelLeave();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved edits. Leave this page without saving?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelLeave}>Stay</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmLeave}>
              Leave without saving
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
