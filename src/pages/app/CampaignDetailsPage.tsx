import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { CampaignStatusBadge } from "@/components/campaigns/CampaignStatusBadge";
import { EmailPreview } from "@/components/composer/EmailPreview";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CampaignQueueActions } from "@/components/queue/CampaignQueueActions";
import {
  CampaignApiError,
  duplicateCampaign,
  fetchCampaign,
  updateCampaign,
  type Campaign,
  type CampaignEvent,
} from "@/lib/campaigns-api";
import { fetchQueueOverview } from "@/lib/queue-api";

export function CampaignDetailsPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [eligibleCount, setEligibleCount] = useState(0);
  const [sourceCount, setSourceCount] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);

  const load = useCallback(() => {
    if (!campaignId) return;
    fetchCampaign(campaignId)
      .then((detail) => {
        setCampaign(detail.campaign);
        setEvents(detail.events);
        setEligibleCount(detail.snapshotEligibleCount);
        setSourceCount(detail.recipientSources.length);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof CampaignApiError ? err.message : "Campaign not found");
      });
  }, [campaignId]);

  useEffect(() => {
    load();
    fetchQueueOverview()
      .then((res) => setQueueEnabled(res.queueEnabled))
      .catch(() => setQueueEnabled(false));
  }, [load]);

  const revertToDraft = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      const { campaign: updated } = await updateCampaign(campaign.id, {
        expectedRevision: campaign.revision,
        revertToDraft: true,
      });
      setCampaign(updated);
      load();
    } catch (err) {
      setError(err instanceof CampaignApiError ? err.message : "Could not revert campaign");
    } finally {
      setBusy(false);
    }
  };

  const handleDuplicate = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      const { campaign: copy } = await duplicateCampaign(campaign.id);
      window.location.href = `/app/campaigns/${copy.id}/edit/`;
    } catch (err) {
      setError(err instanceof CampaignApiError ? err.message : "Could not duplicate");
    } finally {
      setBusy(false);
    }
  };

  if (!campaign && !error) {
    return (
      <AppPageContainer>
        <Skeleton className="h-64 w-full" />
      </AppPageContainer>
    );
  }

  return (
    <>
      <PageMeta
        title="Campaign details | SendStack"
        description="View campaign preparation details and history."
        canonicalPath={`/app/campaigns/${campaignId}/`}
      />
      <AppPageContainer>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <PageHeader
              title={campaign?.name || "Untitled campaign"}
              description={campaign?.description || "Campaign details and preparation history."}
            />
            {campaign && (
              <div className="mt-2">
                <CampaignStatusBadge status={campaign.status} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/app/campaigns/">All campaigns</Link>
            </Button>
            {campaign?.status === "draft" && (
              <Button asChild size="sm">
                <Link to={`/app/campaigns/${campaign.id}/edit/`}>Edit</Link>
              </Button>
            )}
            {campaign && ["ready", "scheduled"].includes(campaign.status) && (
              <Button size="sm" variant="outline" disabled={busy} onClick={revertToDraft}>
                Revert to draft
              </Button>
            )}
            {campaign && (
              <Button size="sm" variant="outline" disabled={busy} onClick={handleDuplicate}>
                Duplicate
              </Button>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {campaign && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Email content</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p><span className="text-muted-foreground">Subject:</span> {campaign.subject || "—"}</p>
                <p>
                  <span className="text-muted-foreground">From:</span>{" "}
                  {[campaign.senderName, campaign.senderEmail].filter(Boolean).join(" · ") || "—"}
                </p>
                <Button type="button" size="sm" variant="outline" onClick={() => setPreviewOpen(true)}>
                  Preview snapshot
                </Button>
                <p className="text-xs text-muted-foreground">
                  Content is frozen from draft {campaign.sourceDraftId ?? "—"} (revision {campaign.contentRevision}).
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Recipients</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>{sourceCount} recipient source(s) selected</p>
                <p>{eligibleCount} eligible recipients in last snapshot</p>
                <p className="text-xs text-muted-foreground">
                  Eligibility may change if contacts unsubscribe or are suppressed later.
                </p>
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Simulation queue</CardTitle>
              </CardHeader>
              <CardContent>
                <CampaignQueueActions campaign={campaign} queueEnabled={queueEnabled} onUpdated={load} />
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Schedule</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {campaign.scheduledAt
                  ? `Intended delivery: ${new Date(campaign.scheduledAt).toLocaleString()} (${campaign.scheduleTimezone ?? "timezone not set"}) — not automatically executed.`
                  : "No intended schedule configured."}
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Recent events</CardTitle>
              </CardHeader>
              <CardContent>
                {events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events recorded yet.</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {events.map((event) => (
                      <li key={event.id} className="flex flex-wrap justify-between gap-2 border-b pb-2">
                        <span>{event.eventType}</span>
                        <span className="text-muted-foreground">
                          {new Date(event.createdAt).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {campaign && (
          <EmailPreview
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            senderName={campaign.senderName}
            senderEmail={campaign.senderEmail}
            subject={campaign.subject}
            bodyHtml={campaign.bodyHtml}
          />
        )}
      </AppPageContainer>
    </>
  );
}
