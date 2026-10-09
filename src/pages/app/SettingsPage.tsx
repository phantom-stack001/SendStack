import { AppPlaceholderSection } from "@/components/dashboard/AppPlaceholderSection";
import { PageMeta } from "@/components/layout/PageMeta";

export function SettingsPage() {
  return (
    <>
      <PageMeta title="Settings | SendStack" description="Account settings." canonicalPath="/app/settings/" />
      <AppPlaceholderSection
        title="Settings"
        description="Account preferences and future SMTP configuration."
        emptyMessage="Account and SpaceMail SMTP settings will be configured on the server in a future phase. Credentials will never be stored in the browser."
      />
    </>
  );
}
