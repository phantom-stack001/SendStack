import { DashboardStats } from "@/components/dashboard/DashboardStats";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { QueueActivity } from "@/components/dashboard/QueueActivity";
import { RecentCampaigns } from "@/components/dashboard/RecentCampaigns";
import { PageMeta } from "@/components/layout/PageMeta";

export function DashboardPage() {
  return (
    <>
      <PageMeta
        title="Dashboard | SendStack"
        description="SendStack dashboard overview for CTN Slovakia."
        canonicalPath="/app/"
      />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Manage your email campaigns and sending activity.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            UI prototype only — authentication and live data are not connected yet.
          </p>
        </div>
        <DashboardStats />
        <QuickActions />
        <div className="grid gap-4 lg:grid-cols-2">
          <RecentCampaigns />
          <QueueActivity />
        </div>
      </div>
    </>
  );
}
