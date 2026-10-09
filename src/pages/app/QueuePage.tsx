import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function QueuePage() {
  return (
    <>
      <PageMeta title="Queue | SendStack" description="Email queue." canonicalPath="/app/queue/" />
      <AppPlaceholderSection
        title="Queue"
        description="Monitor pending and processing outbound messages."
        emptyMessage="No queued emails."
      />
    </>
  );
}
