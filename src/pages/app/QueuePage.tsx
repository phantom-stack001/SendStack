import { ListOrdered } from "lucide-react";

import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function QueuePage() {
  return (
    <>
      <PageMeta title="Queue | SendStack" description="Email queue." canonicalPath="/app/queue/" />
      <AppPlaceholderSection
        title="Queue"
        description="Monitor pending and processing outbound messages."
        icon={ListOrdered}
        emptyMessage="The outbound queue is empty. Real-time worker status will be shown here when BullMQ processing is connected."
      />
    </>
  );
}
