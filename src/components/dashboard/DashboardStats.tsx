import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const stats = [
  { label: "Total Campaigns", value: "—" },
  { label: "Total Recipients", value: "—" },
  { label: "Queued Emails", value: "—" },
  { label: "Sent Emails", value: "—" },
];

export function DashboardStats() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {stat.label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight">{stat.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">No data available</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
