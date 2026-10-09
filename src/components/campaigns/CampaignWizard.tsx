import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { EmailPreview } from "@/components/composer/EmailPreview";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  CampaignApiError,
  type Campaign,
  type EligibilitySummary,
  prepareCampaign,
  updateCampaign,
  validateCampaign,
} from "@/lib/campaigns-api";
import { listDrafts, type Draft } from "@/lib/drafts-api";
import { contactStatusLabel } from "@/lib/contact-status";
import { fetchContactLists, fetchContacts, type Contact, type ContactList } from "@/lib/recipients-api";

const STEPS = ["Details", "Email", "Recipients", "Review", "Prepare"] as const;

type CampaignWizardProps = {
  campaign: Campaign;
  onCampaignChange: (campaign: Campaign) => void;
  initialContactIds?: string[];
  initialListIds?: string[];
};

export function CampaignWizard({
  campaign,
  onCampaignChange,
  initialContactIds,
  initialListIds,
}: CampaignWizardProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(campaign.sourceDraftId);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [contactQ, setContactQ] = useState("");
  const [selectedContactIds, setSelectedContactIds] = useState(
    () => new Set(initialContactIds ?? []),
  );
  const [selectedListIds, setSelectedListIds] = useState(() => new Set(initialListIds ?? []));
  const [eligibility, setEligibility] = useState<EligibilitySummary | null>(null);
  const [validationIssues, setValidationIssues] = useState<{ code: string; message: string }[]>([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(campaign.scheduledAt));
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [scheduleTimezone, setScheduleTimezone] = useState(
    campaign.scheduleTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    listDrafts(1, 50)
      .then((res) => setDrafts(res.drafts))
      .finally(() => setDraftsLoading(false));
  }, []);

  useEffect(() => {
    fetchContacts({ page: 1, limit: 25, q: contactQ.trim() || undefined }).then((res) =>
      setContacts(res.contacts),
    );
    fetchContactLists().then((res) => setLists(res.lists));
  }, [contactQ]);

  const previewContent = useMemo(() => {
    if (campaign.bodyHtml) {
      return {
        senderName: campaign.senderName,
        senderEmail: campaign.senderEmail,
        subject: campaign.subject,
        bodyHtml: campaign.bodyHtml,
      };
    }
    const draft = drafts.find((d) => d.id === selectedDraftId);
    if (!draft) return null;
    return {
      senderName: draft.senderName,
      senderEmail: draft.senderEmail,
      subject: draft.subject,
      bodyHtml: draft.bodyHtml,
    };
  }, [campaign, drafts, selectedDraftId]);

  const patchCampaign = async (
    current: Campaign,
    patch: Omit<Parameters<typeof updateCampaign>[1], "expectedRevision">,
  ) => {
    const { campaign: updated } = await updateCampaign(current.id, {
      expectedRevision: current.revision,
      ...patch,
    });
    onCampaignChange(updated);
    return updated;
  };

  const toggleContact = (id: string) => {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleList = (id: string) => {
    setSelectedListIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const goNext = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      if (step === 0) {
        await patchCampaign(campaign, { name, description });
        setStep(1);
      } else if (step === 1) {
        if (!selectedDraftId) {
          setError("Select an email draft to continue.");
          return;
        }
        await patchCampaign(campaign, { sourceDraftId: selectedDraftId });
        setStep(2);
      } else if (step === 2) {
        const synced = await patchCampaign(campaign, {
          recipientSources: {
            contactIds: [...selectedContactIds],
            contactListIds: [...selectedListIds],
          },
        });
        const prep = await prepareCampaign(synced.id, false);
        setEligibility(prep.eligibility);
        onCampaignChange(prep.campaign);
        setStep(3);
      } else if (step === 3) {
        const result = await validateCampaign(campaign.id);
        setEligibility(result.eligibility);
        setValidationIssues(result.contentIssues);
        setStep(4);
      }
    } catch (err) {
      setError(err instanceof CampaignApiError ? err.message : "Could not save progress");
    } finally {
      setBusy(false);
    }
  };

  const applySchedule = async (current: Campaign) => {
    if (!scheduleEnabled) {
      return patchCampaign(current, { scheduledAt: null, scheduleTimezone: null });
    }
    if (!scheduleLocal) {
      throw new Error("Choose a date and time for the intended schedule.");
    }
    const scheduledAt = new Date(scheduleLocal).toISOString();
    if (new Date(scheduledAt).getTime() <= Date.now()) {
      throw new Error("Scheduled time must be in the future.");
    }
    return patchCampaign(current, { scheduledAt, scheduleTimezone });
  };

  const saveDraft = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let current = campaign;
      current = await patchCampaign(current, { name, description });
      if (selectedDraftId) current = await patchCampaign(current, { sourceDraftId: selectedDraftId });
      current = await patchCampaign(current, {
        recipientSources: {
          contactIds: [...selectedContactIds],
          contactListIds: [...selectedListIds],
        },
      });
      await applySchedule(current);
      setMessage("Campaign saved as draft.");
      navigate(`/app/campaigns/${campaign.id}/`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save campaign");
    } finally {
      setBusy(false);
    }
  };

  const markReady = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let current = campaign;
      current = await patchCampaign(current, { name, description });
      if (selectedDraftId) current = await patchCampaign(current, { sourceDraftId: selectedDraftId });
      current = await patchCampaign(current, {
        recipientSources: {
          contactIds: [...selectedContactIds],
          contactListIds: [...selectedListIds],
        },
      });
      current = await applySchedule(current);
      const prep = await prepareCampaign(current.id, true);
      onCampaignChange(prep.campaign);
      navigate(`/app/campaigns/${campaign.id}/`);
    } catch (err) {
      if (err instanceof CampaignApiError && err.details) {
        const details = err.details as { contentIssues?: { code: string; message: string }[] };
        if (details.contentIssues?.length) {
          setValidationIssues(details.contentIssues);
        }
      }
      setError(err instanceof CampaignApiError ? err.message : "Could not mark campaign ready");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {STEPS.map((label, index) => (
          <div
            key={label}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              index === step
                ? "bg-primary text-primary-foreground"
                : index < step
                  ? "bg-muted text-foreground"
                  : "bg-muted/50 text-muted-foreground"
            }`}
          >
            {index + 1}. {label}
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Campaign details</CardTitle>
            <CardDescription>Name your campaign and add optional context.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="campaign-name">Campaign name</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Spring newsletter"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign-description">Description</Label>
              <Textarea
                id="campaign-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional notes for your team"
                rows={4}
                maxLength={2000}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Email content</CardTitle>
            <CardDescription>
              Choose a saved draft. SendStack stores an independent snapshot on the campaign.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {draftsLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : drafts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No drafts yet.{" "}
                <Link className="text-primary underline" to="/app/compose/">Create a draft</Link> first.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {drafts.map((draft) => (
                  <li key={draft.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div>
                      <p className="font-medium">{draft.subject || "Untitled draft"}</p>
                      <p className="text-xs text-muted-foreground">
                        {draft.senderName || "Sender"} · {draft.senderEmail || "email not set"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={selectedDraftId === draft.id ? "default" : "outline"}
                      onClick={() => setSelectedDraftId(draft.id)}
                    >
                      {selectedDraftId === draft.id ? "Selected" : "Select"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {previewContent && (
              <Button type="button" variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                Preview email
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Contacts</CardTitle>
              <CardDescription>Search and select individual contacts.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                placeholder="Search contacts"
                value={contactQ}
                onChange={(e) => setContactQ(e.target.value)}
              />
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {contacts.map((contact) => (
                  <li key={contact.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedContactIds.has(contact.id)}
                      onChange={() => toggleContact(contact.id)}
                      aria-label={`Select ${contact.email}`}
                    />
                    <span>{contact.email}</span>
                    <span className="text-muted-foreground">({contactStatusLabel(contact.subscriptionStatus)})</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Contact lists</CardTitle>
              <CardDescription>Include entire lists; duplicates are removed automatically.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {lists.map((list) => (
                  <li key={list.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedListIds.has(list.id)}
                      onChange={() => toggleList(list.id)}
                      aria-label={`Select list ${list.name}`}
                    />
                    <span>{list.name}</span>
                    <span className="text-muted-foreground">({list.memberCount} members)</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Review</CardTitle>
              <CardDescription>Confirm details before preparing the campaign.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p><span className="text-muted-foreground">Name:</span> {name || "—"}</p>
              <p><span className="text-muted-foreground">Subject:</span> {campaign.subject || "—"}</p>
              <p>
                <span className="text-muted-foreground">Recipients:</span>{" "}
                {selectedContactIds.size} contacts, {selectedListIds.size} lists
              </p>
              {eligibility && (
                <div className="mt-4 rounded-md border p-3">
                  <p className="font-medium">Recipient eligibility</p>
                  <ul className="mt-2 space-y-1 text-muted-foreground">
                    <li>Selected (raw): {eligibility.selectedRaw}</li>
                    <li>Duplicates removed: {eligibility.duplicates}</li>
                    <li>Eligible: {eligibility.eligible}</li>
                    <li>Excluded: {eligibility.excludedTotal}</li>
                  </ul>
                </div>
              )}
              {validationIssues.length > 0 && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive">
                  <p className="font-medium">Content issues</p>
                  <ul className="mt-1 list-disc pl-5">
                    {validationIssues.map((issue) => (
                      <li key={issue.code}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle>Save &amp; prepare</CardTitle>
            <CardDescription>
              Delivery is not available in this phase. You can save a draft, mark the campaign ready, or
              record an intended schedule for a future release.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <input
                id="schedule-enabled"
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
              />
              <Label htmlFor="schedule-enabled">Configure intended delivery schedule</Label>
            </div>
            {scheduleEnabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="schedule-at">Date &amp; time (your local browser time)</Label>
                  <Input
                    id="schedule-at"
                    type="datetime-local"
                    value={scheduleLocal}
                    onChange={(e) => setScheduleLocal(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="schedule-tz">Timezone label</Label>
                  <Input
                    id="schedule-tz"
                    value={scheduleTimezone}
                    onChange={(e) => setScheduleTimezone(e.target.value)}
                  />
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Scheduled times are stored for planning only. No background job will send this campaign
              automatically.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="outline" disabled={step === 0 || busy} onClick={() => setStep((s) => s - 1)}>
          Back
        </Button>
        <div className="flex flex-wrap gap-2">
          {step === 4 ? (
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={saveDraft}>
                Save as draft
              </Button>
              <Button type="button" disabled={busy} onClick={markReady}>
                Mark as ready
              </Button>
            </>
          ) : (
            <Button type="button" disabled={busy} onClick={goNext}>
              Next
            </Button>
          )}
        </div>
      </div>

      {previewContent && (
        <EmailPreview
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          senderName={previewContent.senderName}
          senderEmail={previewContent.senderEmail}
          subject={previewContent.subject}
          bodyHtml={previewContent.bodyHtml}
        />
      )}
    </div>
  );
}
