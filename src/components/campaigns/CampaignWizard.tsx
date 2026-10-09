import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { EmailPreview } from "@/components/composer/EmailPreview";
import { RecipientEligibilitySummary } from "@/components/campaigns/RecipientEligibilitySummary";
import { RecipientStatusBadge } from "@/components/campaigns/RecipientStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  CampaignApiError,
  type Campaign,
  type ContactListEligibilityHint,
  type EligibilitySummary,
  type RecipientEligibilityExclusion,
  prepareCampaign,
  previewRecipientEligibility,
  updateCampaign,
  validateCampaign,
} from "@/lib/campaigns-api";
import { recipientDisplayStatus } from "@/lib/campaign-eligibility-ui";
import { listDrafts, type Draft } from "@/lib/drafts-api";
import {
  fetchContactLists,
  fetchContacts,
  fetchSuppressions,
  type Contact,
  type ContactList,
} from "@/lib/recipients-api";

const STEPS = ["Details", "Email", "Recipients", "Review", "Prepare"] as const;
const RECIPIENTS_STEP = 2;

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
  const [exclusions, setExclusions] = useState<RecipientEligibilityExclusion[]>([]);
  const [listHints, setListHints] = useState<ContactListEligibilityHint[]>([]);
  const [eligibilityLoading, setEligibilityLoading] = useState(false);
  const [eligibilityPreviewError, setEligibilityPreviewError] = useState<string | null>(null);
  const [contentIssues, setContentIssues] = useState<{ code: string; message: string }[]>([]);
  const [recipientIssues, setRecipientIssues] = useState<{ code: string; message: string }[]>([]);
  const [canMarkReady, setCanMarkReady] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [prepareBlock, setPrepareBlock] = useState<string | null>(null);
  const [suppressedEmails, setSuppressedEmails] = useState<Set<string>>(() => new Set());
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(campaign.scheduledAt));
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [scheduleTimezone, setScheduleTimezone] = useState(
    campaign.scheduleTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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

  useEffect(() => {
    if (step !== RECIPIENTS_STEP) return;
    fetchSuppressions({ page: 1, limit: 100 })
      .then((res) => setSuppressedEmails(new Set(res.suppressions.map((s) => s.email.toLowerCase()))))
      .catch(() => setSuppressedEmails(new Set()));
  }, [step]);

  const refreshEligibilityPreview = useCallback(async () => {
    setEligibilityPreviewError(null);
    setEligibilityLoading(true);
    try {
      const result = await previewRecipientEligibility({
        contactIds: [...selectedContactIds],
        contactListIds: [...selectedListIds],
      });
      setEligibility(result.summary);
      setExclusions(result.exclusions);
      setListHints(result.listHints);
      if (result.summary.eligible > 0) {
        setRecipientIssues([]);
        setPrepareBlock(null);
      }
    } catch {
      setEligibilityPreviewError("Could not refresh eligibility. Check your connection and try again.");
    } finally {
      setEligibilityLoading(false);
    }
  }, [selectedContactIds, selectedListIds]);

  useEffect(() => {
    if (step !== RECIPIENTS_STEP) return;
    const timer = window.setTimeout(() => {
      void refreshEligibilityPreview();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [step, refreshEligibilityPreview]);

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedDraftId) ?? null,
    [drafts, selectedDraftId],
  );

  const senderPreview = useMemo(() => {
    if (campaign.bodyHtml && campaign.sourceDraftId === selectedDraftId) {
      return {
        senderName: campaign.senderName,
        senderEmail: campaign.senderEmail,
        subject: campaign.subject,
        bodyHtml: campaign.bodyHtml,
      };
    }
    if (!selectedDraft) return null;
    return {
      senderName: selectedDraft.senderName,
      senderEmail: selectedDraft.senderEmail,
      subject: selectedDraft.subject,
      bodyHtml: selectedDraft.bodyHtml,
    };
  }, [campaign, selectedDraft, selectedDraftId]);

  const exclusionByContactId = useMemo(() => {
    const map = new Map<string, RecipientEligibilityExclusion>();
    for (const row of exclusions) {
      if (row.contactId) map.set(row.contactId, row);
    }
    return map;
  }, [exclusions]);

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

  const goToRecipients = () => {
    setPrepareBlock(null);
    setActionError(null);
    setStep(RECIPIENTS_STEP);
  };

  const goNext = async () => {
    setActionError(null);
    setMessage(null);
    setBusy(true);
    try {
      if (step === 0) {
        setDetailsError(null);
        if (name.trim().length > 200) {
          setDetailsError("Campaign name must be 200 characters or fewer.");
          return;
        }
        if (description.length > 2000) {
          setDetailsError("Description must be 2000 characters or fewer.");
          return;
        }
        await patchCampaign(campaign, { name, description });
        setStep(1);
      } else if (step === 1) {
        setEmailError(null);
        if (!selectedDraftId) {
          setEmailError("Select an email draft to continue.");
          return;
        }
        await patchCampaign(campaign, { sourceDraftId: selectedDraftId });
        setStep(2);
      } else if (step === 2) {
        setRecipientIssues([]);
        const synced = await patchCampaign(campaign, {
          recipientSources: {
            contactIds: [...selectedContactIds],
            contactListIds: [...selectedListIds],
          },
        });
        const prep = await prepareCampaign(synced.id, false);
        setEligibility(prep.eligibility);
        onCampaignChange(prep.campaign);
        if (prep.eligibility.eligible === 0 && prep.eligibility.selectedRaw > 0) {
          setRecipientIssues([
            {
              code: "NO_ELIGIBLE_RECIPIENTS",
              message: "No eligible recipients are currently selected.",
            },
          ]);
        } else if (prep.eligibility.selectedRaw === 0) {
          setRecipientIssues([
            {
              code: "NO_RECIPIENT_SOURCES",
              message: "Select at least one contact or contact list to target recipients.",
            },
          ]);
        }
        setStep(3);
      } else if (step === 3) {
        const result = await validateCampaign(campaign.id);
        setEligibility(result.eligibility);
        setExclusions(result.exclusions);
        setContentIssues(result.contentIssues);
        setRecipientIssues(result.recipientIssues);
        setCanMarkReady(result.canMarkReady);
        setStep(4);
      }
    } catch (err) {
      setActionError(err instanceof CampaignApiError ? err.message : "Could not save progress");
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
    setActionError(null);
    setPrepareBlock(null);
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
      setActionError(err instanceof Error ? err.message : "Could not save campaign");
    } finally {
      setBusy(false);
    }
  };

  const markReady = async () => {
    setBusy(true);
    setActionError(null);
    setPrepareBlock(null);
    setMessage(null);
    try {
      let current = campaign;
      current = await patchCampaign(current, { name, description });
      if (!current.name.trim()) {
        setPrepareBlock("Campaign name is required before marking ready.");
        setStep(0);
        return;
      }
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
      if (err instanceof CampaignApiError) {
        const payload = err.details as {
          code?: string;
          eligibility?: EligibilitySummary;
          contentIssues?: { code: string; message: string }[];
        };
        if (payload.eligibility) setEligibility(payload.eligibility);
        if (payload.contentIssues?.length) setContentIssues(payload.contentIssues);
        if (payload.code === "NO_ELIGIBLE_RECIPIENTS") {
          setPrepareBlock(
            "This campaign cannot be marked ready because no eligible recipients are selected.",
          );
          setRecipientIssues([
            {
              code: "NO_ELIGIBLE_RECIPIENTS",
              message: "No eligible recipients are currently selected.",
            },
          ]);
          return;
        }
      }
      setActionError(err instanceof CampaignApiError ? err.message : "Could not mark campaign ready");
    } finally {
      setBusy(false);
    }
  };

  const listHintMap = useMemo(
    () => new Map(listHints.map((hint) => [hint.listId, hint])),
    [listHints],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2" aria-label="Campaign wizard progress">
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

      {actionError && (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Campaign details</CardTitle>
            <CardDescription>Name your campaign and add optional context.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {detailsError && (
              <p className="text-sm text-destructive" role="alert">{detailsError}</p>
            )}
            <div className="space-y-2">
              <Label htmlFor="campaign-name">Campaign name</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setDetailsError(null);
                }}
                placeholder="Spring newsletter"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign-description">Description</Label>
              <Textarea
                id="campaign-description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setDetailsError(null);
                }}
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
              Choose a saved draft. SendStack stores an independent snapshot on the campaign when you
              continue.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {emailError && (
              <p className="text-sm text-destructive" role="alert">{emailError}</p>
            )}
            {contentIssues.length > 0 && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                role="alert"
              >
                <p className="font-medium">Email content issues</p>
                <ul className="mt-1 list-disc pl-5">
                  {contentIssues.map((issue) => (
                    <li key={issue.code}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
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
                        From: {draft.senderName || "—"} · {draft.senderEmail || "not set"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={selectedDraftId === draft.id ? "default" : "outline"}
                      onClick={() => {
                        setSelectedDraftId(draft.id);
                        setEmailError(null);
                      }}
                    >
                      {selectedDraftId === draft.id ? "Selected" : "Select"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {senderPreview && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
                <p className="font-medium">Selected email (sender)</p>
                <p>
                  <span className="text-muted-foreground">From name:</span>{" "}
                  {senderPreview.senderName || "—"}
                </p>
                <p>
                  <span className="text-muted-foreground">From email:</span>{" "}
                  {senderPreview.senderEmail || "—"}
                </p>
                <p>
                  <span className="text-muted-foreground">Subject:</span>{" "}
                  {senderPreview.subject || "—"}
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setPreviewOpen(true)}>
                  Preview email
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {recipientIssues.length > 0 && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              <p className="font-medium">{recipientIssues[0]?.message}</p>
              <p className="mt-1 text-destructive/90">
                Selected contacts must have valid permission and must not be unsubscribed or
                suppressed.
              </p>
            </div>
          )}
          {eligibilityPreviewError && (
            <p className="text-sm text-destructive" role="alert">{eligibilityPreviewError}</p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Contacts</CardTitle>
                <CardDescription>
                  Select individual contacts. Ineligible contacts stay visible for planning but do not
                  count toward delivery.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="Search contacts"
                  value={contactQ}
                  onChange={(e) => setContactQ(e.target.value)}
                />
                <ul className="max-h-64 space-y-2 overflow-y-auto">
                  {contacts.map((contact) => {
                    const display = recipientDisplayStatus(
                      contact.subscriptionStatus,
                      suppressedEmails.has(contact.email.toLowerCase()),
                    );
                    const exclusion = exclusionByContactId.get(contact.id);
                    const eligible = !exclusion && display === "subscribed";
                    return (
                      <li key={contact.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedContactIds.has(contact.id)}
                          onChange={() => toggleContact(contact.id)}
                          aria-label={`Select ${contact.email}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{contact.email}</span>
                        <RecipientStatusBadge status={display} eligible={eligible} />
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Contact lists</CardTitle>
                <CardDescription>
                  Include entire lists; duplicates across sources are removed automatically.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {lists.map((list) => {
                    const hint = listHintMap.get(list.id);
                    return (
                      <li key={list.id} className="flex flex-wrap items-start gap-2 text-sm">
                        <input
                          className="mt-1"
                          type="checkbox"
                          checked={selectedListIds.has(list.id)}
                          onChange={() => toggleList(list.id)}
                          aria-label={`Select list ${list.name}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{list.name}</p>
                          <p className="text-muted-foreground">
                            {list.memberCount === 0
                              ? "Empty list"
                              : `${list.memberCount} member${list.memberCount === 1 ? "" : "s"}`}
                            {hint && list.memberCount > 0 && (
                              <>
                                {" "}
                                · ~{hint.eligible} eligible, {hint.excluded} excluded
                              </>
                            )}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </div>
          {eligibilityLoading && !eligibility ? (
            <Skeleton className="h-32 w-full" />
          ) : eligibility ? (
            <RecipientEligibilitySummary summary={eligibility} exclusions={exclusions} />
          ) : null}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Review</CardTitle>
              <CardDescription>Confirm details before preparing the campaign.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 text-sm">
              <section>
                <h3 className="font-medium">Campaign details</h3>
                <p className="mt-1">
                  <span className="text-muted-foreground">Name:</span> {name.trim() || "—"}
                </p>
                <p className="mt-1">
                  <span className="text-muted-foreground">Description:</span>{" "}
                  {description.trim() || "—"}
                </p>
              </section>
              <section>
                <h3 className="font-medium">Email</h3>
                <p className="mt-1">
                  <span className="text-muted-foreground">From name:</span>{" "}
                  {campaign.senderName || senderPreview?.senderName || "—"}
                </p>
                <p className="mt-1">
                  <span className="text-muted-foreground">From email:</span>{" "}
                  {campaign.senderEmail || senderPreview?.senderEmail || "—"}
                </p>
                <p className="mt-1">
                  <span className="text-muted-foreground">Subject:</span>{" "}
                  {campaign.subject || senderPreview?.subject || "—"}
                </p>
                {senderPreview && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => setPreviewOpen(true)}
                  >
                    Preview email
                  </Button>
                )}
              </section>
              <section>
                <h3 className="font-medium">Recipients</h3>
                <p className="mt-1">
                  <span className="text-muted-foreground">Individual contacts selected:</span>{" "}
                  {selectedContactIds.size}
                </p>
                <p className="mt-1">
                  <span className="text-muted-foreground">Lists selected:</span> {selectedListIds.size}
                </p>
                {eligibility && (
                  <>
                    <p className="mt-1">
                      <span className="text-muted-foreground">Unique recipients:</span>{" "}
                      {eligibility.uniqueEmails}
                    </p>
                    <p className="mt-1">
                      <span className="text-muted-foreground">Eligible recipients:</span>{" "}
                      {eligibility.eligible}
                    </p>
                    <p className="mt-1">
                      <span className="text-muted-foreground">Excluded recipients:</span>{" "}
                      {eligibility.excludedTotal}
                    </p>
                  </>
                )}
              </section>
              {eligibility && (
                <section>
                  <h3 className="font-medium">Eligibility</h3>
                  <div className="mt-2">
                    <RecipientEligibilitySummary
                      summary={eligibility}
                      exclusions={exclusions}
                      compact={exclusions.length > 8}
                    />
                  </div>
                </section>
              )}
              {contentIssues.length > 0 && (
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive"
                  role="alert"
                >
                  <p className="font-medium">Blocking email issues</p>
                  <ul className="mt-1 list-disc pl-5">
                    {contentIssues.map((issue) => (
                      <li key={issue.code}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {recipientIssues.length > 0 && (
                <div
                  className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
                  role="status"
                >
                  <p className="font-medium">Recipient warnings</p>
                  <ul className="mt-1 list-disc pl-5">
                    {recipientIssues.map((issue) => (
                      <li key={issue.code}>{issue.message}</li>
                    ))}
                  </ul>
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={goToRecipients}>
                    Review recipients
                  </Button>
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
              Delivery is not available in this phase. Save a draft, mark ready when eligible, or
              record an intended schedule for simulation testing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {prepareBlock && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                role="alert"
              >
                <p className="font-medium">{prepareBlock}</p>
                <p className="mt-1">
                  Selected contacts must have valid permission and must not be unsubscribed or
                  suppressed.
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={goToRecipients}>
                  Review recipients
                </Button>
              </div>
            )}
            {!prepareBlock && !canMarkReady && eligibility && eligibility.eligible === 0 && (
              <div className="rounded-md border p-3 text-sm" role="status">
                <p className="font-medium">Mark as ready requires eligible recipients</p>
                <p className="mt-1 text-muted-foreground">
                  You can still save this campaign as a draft while you fix recipient targeting.
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={goToRecipients}>
                  Review recipients
                </Button>
              </div>
            )}
            {canMarkReady && eligibility && eligibility.eligible > 0 && (
              <p className="text-sm text-muted-foreground" role="status">
                {eligibility.eligible} eligible recipient{eligibility.eligible === 1 ? "" : "s"} ready
                for simulation queue activation.
              </p>
            )}
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
              Scheduled times are stored in UTC for planning. Simulation activation still requires a
              ready campaign and queue workers.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={step === 0 || busy}
          onClick={() => {
            setActionError(null);
            setStep((s) => s - 1);
          }}
        >
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

      {senderPreview && (
        <EmailPreview
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          senderName={senderPreview.senderName}
          senderEmail={senderPreview.senderEmail}
          subject={senderPreview.subject}
          bodyHtml={senderPreview.bodyHtml}
        />
      )}
    </div>
  );
}
