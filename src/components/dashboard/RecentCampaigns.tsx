import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function RecentCampaigns() {
  return (
    <Card className="flex-1">
      <CardHeader>
        <CardTitle>Recent Campaigns</CardTitle>
        <CardDescription>Latest campaign activity will appear here.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">No campaigns yet.</p>
      </CardContent>
    </Card>
  );
}
