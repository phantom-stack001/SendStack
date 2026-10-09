import { Users } from "lucide-react";

import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function RecipientsPage() {
  return (
    <>
      <PageMeta title="Recipients | SendStack" description="Recipient lists." canonicalPath="/app/recipients/" />
      <AppPlaceholderSection
        title="Recipients"
        description="Manage contact lists and consent-aware audiences."
        icon={Users}
        emptyMessage="Recipient lists and import tools will appear here in a future phase. Consent metadata will be enforced server-side."
      />
    </>
  );
}
