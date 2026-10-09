import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function RecipientsPage() {
  return (
    <>
      <PageMeta title="Recipients | SendStack" description="Recipient lists." canonicalPath="/app/recipients/" />
      <AppPlaceholderSection
        title="Recipients"
        description="Manage contact lists and consent-aware audiences."
        emptyMessage="No recipients yet."
      />
    </>
  );
}
