import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function ComposePage() {
  return (
    <>
      <PageMeta
        title="Compose | SendStack"
        description="Compose emails in SendStack."
        canonicalPath="/app/compose/"
      />
      <AppPlaceholderSection
        title="Compose"
        description="Draft and preview outbound messages."
        emptyMessage="The rich text email composer will be developed in a future phase. SMTP sending will remain server-side through SpaceMail."
      />
    </>
  );
}
