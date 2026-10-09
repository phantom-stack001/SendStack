import { FileText } from "lucide-react";

import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function TemplatesPage() {
  return (
    <>
      <PageMeta title="Templates | SendStack" description="Email templates." canonicalPath="/app/templates/" />
      <AppPlaceholderSection
        title="Templates"
        description="Reusable message layouts and saved drafts."
        icon={FileText}
        emptyMessage="Template library management will be added when the composer is implemented."
      />
    </>
  );
}
