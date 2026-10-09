import { StatCard } from "@/components/shared/StatCard";

type QueueStatsProps = {
  stats: Record<string, number>;
};

export function QueueStats({ stats }: QueueStatsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard
        label="Pending / queued"
        value={((stats.pending ?? 0) + (stats.queued ?? 0)).toLocaleString()}
        hint="Waiting for simulation workers"
      />
      <StatCard
        label="Processing"
        value={(stats.processing ?? 0).toLocaleString()}
        hint="Currently simulating"
      />
      <StatCard
        label="Simulation completed"
        value={(stats.simulation_completed ?? 0).toLocaleString()}
        hint="Not actual email delivery"
      />
      <StatCard label="Failed" value={(stats.simulation_failed ?? 0).toLocaleString()} hint="Terminal simulation errors" />
      <StatCard label="Skipped" value={(stats.skipped ?? 0).toLocaleString()} hint="Ineligible at processing time" />
      <StatCard label="Cancelled" value={(stats.cancelled ?? 0).toLocaleString()} hint="Stopped before simulation" />
    </div>
  );
}
