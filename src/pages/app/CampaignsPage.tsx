import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function CampaignsPage() {
  return (
    <>
      <PageMeta title="Campaigns | SendStack" description="Campaign management." canonicalPath="/app/campaigns/" />
      <AppPlaceholderSection
        title="Campaigns"
        description="Create, schedule, and monitor email campaigns."
        emptyMessage="No campaigns yet."
      />
    </>
  );
}
