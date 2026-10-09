import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function QueueActivity() {
  return (
    <Card className="flex-1">
      <CardHeader>
        <CardTitle>Queue Activity</CardTitle>
        <CardDescription>Background queue status will appear here.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">No queued emails.</p>
      </CardContent>
    </Card>
  );
}
