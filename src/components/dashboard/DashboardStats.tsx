import { StatCard } from "@/components/shared/StatCard";

const stats = [
  { label: "Total Campaigns", value: "—" },
  { label: "Total Recipients", value: "—" },
  { label: "Queued Emails", value: "—" },
  { label: "Sent Emails", value: "—" },
];

export function DashboardStats() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {stats.map((stat) => (
        <StatCard key={stat.label} label={stat.label} value={stat.value} />
      ))}
    </div>
  );
}
