import { ListOrdered } from "lucide-react";
import { Link } from "react-router-dom";

import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function QueueActivity() {
  return (
    <Card className="flex flex-1 flex-col">
      <CardHeader>
        <CardTitle>Queue Activity</CardTitle>
        <CardDescription>Background queue status will appear here when workers are running.</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <EmptyState
          icon={ListOrdered}
          title="No queued emails"
          description="Outbound messages will show up here once the server-side queue is implemented."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/app/queue/">Open queue</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
