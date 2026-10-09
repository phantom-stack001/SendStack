import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { CampaignWizard } from "@/components/campaigns/CampaignWizard";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CampaignApiError, createCampaign, type Campaign } from "@/lib/campaigns-api";

export function CreateCampaignPage() {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createCampaign()
      .then((res) => setCampaign(res.campaign))
      .catch((err) => {
        setError(err instanceof CampaignApiError ? err.message : "Could not create campaign");
      });
  }, []);

  return (
    <>
      <PageMeta
        title="Create campaign | SendStack"
        description="Create and prepare a new email campaign."
        canonicalPath="/app/campaigns/new/"
      />
      <AppPageContainer>
        <PageHeader
          className="mb-4"
          title="Create campaign"
          description="Follow the steps to prepare a new email campaign."
          actions={<Button asChild variant="outline"><Link to="/app/campaigns/">Back to campaigns</Link></Button>}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!campaign ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <CampaignWizard campaign={campaign} onCampaignChange={setCampaign} />
        )}
      </AppPageContainer>
    </>
  );
}
