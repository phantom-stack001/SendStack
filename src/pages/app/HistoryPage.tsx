import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function HistoryPage() {
  return (
    <>
      <PageMeta title="Sending History | SendStack" description="Delivery history." canonicalPath="/app/history/" />
      <AppPlaceholderSection
        title="Sending History"
        description="Review submitted sends and delivery outcomes."
        emptyMessage="No sending history yet."
      />
    </>
  );
}
