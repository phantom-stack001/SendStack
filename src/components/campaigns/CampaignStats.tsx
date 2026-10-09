import { StatCard } from "@/components/shared/StatCard";

type CampaignStatsProps = {
  stats: {
    total: number;
    draft: number;
    ready: number;
    scheduled: number;
  };
};

export function CampaignStats({ stats }: CampaignStatsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total campaigns" value={stats.total.toLocaleString()} hint="All campaigns you own" />
      <StatCard label="Draft" value={stats.draft.toLocaleString()} hint="In progress" />
      <StatCard label="Ready" value={stats.ready.toLocaleString()} hint="Prepared, not yet deliverable" />
      <StatCard
        label="Scheduled intentions"
        value={stats.scheduled.toLocaleString()}
        hint="Future delivery time recorded only"
      />
    </div>
  );
}
