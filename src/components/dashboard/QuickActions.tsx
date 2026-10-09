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
      <CardContent className="grid gap-2 sm:flex sm:flex-wrap">
        {actions.map((action, index) => (
          <Button
            key={action.label}
            asChild
            variant={index === 0 ? "default" : "outline"}
            className="w-full sm:w-auto"
          >
            <Link to={action.href}>{action.label}</Link>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
