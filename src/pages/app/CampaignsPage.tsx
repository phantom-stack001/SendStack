import { Mail } from "lucide-react";
import { Link } from "react-router-dom";

import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";
import { Button } from "@/components/ui/button";

export function CampaignsPage() {
  return (
    <>
      <PageMeta title="Campaigns | SendStack" description="Campaign management." canonicalPath="/app/campaigns/" />
      <AppPlaceholderSection
        title="Campaigns"
        description="Create, schedule, and monitor email campaigns."
        icon={Mail}
        emptyMessage="Campaigns will be listed here after the delivery backend is connected. No sample or placeholder activity is shown."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/app/compose/">Go to compose</Link>
          </Button>
        }
      />
    </>
  );
}
