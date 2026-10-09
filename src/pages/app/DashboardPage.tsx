import { DashboardStats } from "@/components/dashboard/DashboardStats";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { QueueActivity } from "@/components/dashboard/QueueActivity";
import { RecentCampaigns } from "@/components/dashboard/RecentCampaigns";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";

export function DashboardPage() {
  return (
    <>
      <PageMeta
        title="Dashboard | SendStack"
        description="SendStack dashboard overview for CTN Slovakia."
        canonicalPath="/app/"
      />
      <AppPageContainer>
        <PageHeader
          title="Dashboard"
          description="Manage your email campaigns and sending activity."
          notice="Email delivery is not enabled — queue jobs run in simulation-only mode when Redis workers are active."
        />
        <DashboardStats />
        <QuickActions />
        <div className="grid gap-4 lg:grid-cols-2">
          <RecentCampaigns />
          <QueueActivity />
        </div>
      </AppPageContainer>
    </>
  );
}
