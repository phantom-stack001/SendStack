import { Settings } from "lucide-react";

import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function SettingsPage() {
  return (
    <>
      <PageMeta title="Settings | SendStack" description="Account settings." canonicalPath="/app/settings/" />
      <AppPlaceholderSection
        title="Settings"
        description="Account preferences and future email delivery configuration."
        icon={Settings}
        emptyTitle="Settings not configured"
        emptyMessage="Account and email delivery settings will be configured on the server in a future phase. Credentials will never be stored in the browser."
      />
    </>
  );
}
