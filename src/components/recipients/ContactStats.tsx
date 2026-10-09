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
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const notSubscribed =
    stats.unsubscribed + stats.pending + stats.unknown;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatCard label="Contacts" value={stats.total.toLocaleString()} hint="All contacts" />
      <StatCard label="Subscribed" value={stats.subscribed.toLocaleString()} hint="Can receive campaigns" />
      <StatCard label="Unsubscribed" value={notSubscribed.toLocaleString()} hint="Not subscribed" />
    </div>
  );
}
