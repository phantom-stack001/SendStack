import { Mail } from "lucide-react";
import { Link } from "react-router-dom";

import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function RecentCampaigns() {
  return (
    <Card className="flex flex-1 flex-col">
      <CardHeader>
        <CardTitle>Recent Campaigns</CardTitle>
        <CardDescription>Latest campaign activity will appear here when sending is enabled.</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <EmptyState
          icon={Mail}
          title="No campaigns yet"
          description="Create a campaign after the composer and delivery backend are connected."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/app/campaigns/">View campaigns</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
