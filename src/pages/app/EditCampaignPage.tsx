import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { CampaignWizard } from "@/components/campaigns/CampaignWizard";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CampaignApiError, fetchCampaign, type Campaign } from "@/lib/campaigns-api";

export function EditCampaignPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [sources, setSources] = useState<Awaited<ReturnType<typeof fetchCampaign>>["recipientSources"]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!campaignId) return;
    fetchCampaign(campaignId)
      .then((detail) => {
        setCampaign(detail.campaign);
        setSources(detail.recipientSources);
      })
      .catch((err) => {
        setError(err instanceof CampaignApiError ? err.message : "Campaign not found");
      });
  }, [campaignId]);

  const initialContactIds = useMemo(
    () =>
      sources
        .filter((s) => s.sourceType === "individual_contact" && s.contactId)
        .map((s) => s.contactId as string),
    [sources],
  );
  const initialListIds = useMemo(
    () =>
      sources
        .filter((s) => s.sourceType === "contact_list" && s.contactListId)
        .map((s) => s.contactListId as string),
    [sources],
  );

  return (
    <>
      <PageMeta
        title="Edit campaign | SendStack"
        description="Edit a draft email campaign."
        canonicalPath={`/app/campaigns/${campaignId}/edit/`}
      />
      <AppPageContainer>
        <div className="mb-4 flex items-center justify-between gap-2">
          <PageHeader title="Edit campaign" description="Update draft campaign settings and targeting." />
          <Button asChild variant="outline" size="sm">
            <Link to={`/app/campaigns/${campaignId}/`}>View details</Link>
          </Button>
        </div>
        {error && (
          <Card>
            <CardContent className="py-6 text-sm text-destructive">{error}</CardContent>
          </Card>
        )}
        {!campaign && !error ? <Skeleton className="h-64 w-full" /> : null}
        {campaign && campaign.status !== "draft" ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              This campaign is not in draft status. Revert it to draft from the details page before editing.
            </CardContent>
          </Card>
        ) : null}
        {campaign?.status === "draft" ? (
          <CampaignWizard
            campaign={campaign}
            onCampaignChange={setCampaign}
            initialContactIds={initialContactIds}
            initialListIds={initialListIds}
          />
        ) : null}
      </AppPageContainer>
    </>
  );
}
