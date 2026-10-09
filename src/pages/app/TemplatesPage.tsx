import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function TemplatesPage() {
  return (
    <>
      <PageMeta title="Templates | SendStack" description="Email templates." canonicalPath="/app/templates/" />
      <AppPlaceholderSection
        title="Templates"
        description="Reusable message templates for your team."
        emptyMessage="No templates yet."
      />
    </>
  );
}
