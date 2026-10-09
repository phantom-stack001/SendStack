import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const actions = [
  { label: "Compose Email", href: "/app/compose/" },
  { label: "View Campaigns", href: "/app/campaigns/" },
  { label: "Manage Recipients", href: "/app/recipients/" },
  { label: "View Queue", href: "/app/queue/" },
];

export function QuickActions() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick Actions</CardTitle>
        <CardDescription>Jump to common workspace tasks.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button key={action.label} asChild variant="secondary">
            <Link to={action.href}>{action.label}</Link>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
