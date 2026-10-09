import { StatCard } from "@/components/shared/StatCard";
import { Skeleton } from "@/components/ui/skeleton";

type ContactStatsProps = {
  stats: {
    total: number;
    subscribed: number;
    unsubscribed: number;
    pending: number;
    unknown: number;
  } | null;
  loading?: boolean;
};

export function ContactStats({ stats, loading }: ContactStatsProps) {
  if (loading || !stats) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total contacts" value={stats.total.toLocaleString()} hint="All contacts in your account" />
      <StatCard label="Subscribed" value={stats.subscribed.toLocaleString()} hint="Eligible with recorded consent" />
      <StatCard label="Unsubscribed" value={stats.unsubscribed.toLocaleString()} hint="Opted out or suppressed" />
      <StatCard
        label="Pending / unknown"
        value={(stats.pending + stats.unknown).toLocaleString()}
        hint="Not confirmed for marketing"
      />
    </div>
  );
}
