import type { LucideIcon } from "lucide-react";

import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";

type AppPlaceholderSectionProps = {
  title: string;
  description: string;
  emptyTitle?: string;
  emptyMessage: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
};

export function AppPlaceholderSection({
  title,
  description,
  emptyTitle = "Nothing here yet",
  emptyMessage,
  icon,
  action,
}: AppPlaceholderSectionProps) {
  return (
    <AppPageContainer>
      <PageHeader
        title={title}
        description={description}
        notice="UI prototype only — live data and sending are not connected yet."
      />
      <EmptyState icon={icon} title={emptyTitle} description={emptyMessage} action={action} />
    </AppPageContainer>
  );
}
