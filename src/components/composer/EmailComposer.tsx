import { generateHTML } from "@tiptap/html";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBlocker, useNavigate } from "react-router-dom";

import { ComposerHeader } from "@/components/composer/ComposerHeader";
import { EmailPreview } from "@/components/composer/EmailPreview";
import { RichTextEditor } from "@/components/composer/RichTextEditor";
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
import { composerExtensions } from "@/lib/tiptap-extensions";

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

  const dirty = !statesEqual(form, savedSnapshot);
  const blocker = useBlocker(dirty && !saving);
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

      const snapshot = buildFormStateFromDraft(saved);
      setSavedSnapshot(snapshot);
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
      />

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
