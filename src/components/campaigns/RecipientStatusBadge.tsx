import { Badge } from "@/components/ui/badge";
import {
  RECIPIENT_STATUS_HELP,
  RECIPIENT_STATUS_LABELS,
  type RecipientDisplayStatus,
} from "@/lib/campaign-eligibility-ui";

type RecipientStatusBadgeProps = {
  status: RecipientDisplayStatus;
  eligible?: boolean;
};

export function RecipientStatusBadge({ status, eligible }: RecipientStatusBadgeProps) {
  const variant =
    status === "subscribed" && eligible !== false
      ? "default"
      : status === "suppressed" || status === "unsubscribed"
        ? "destructive"
        : "secondary";

  const title = RECIPIENT_STATUS_HELP[status];

  return (
    <Badge variant={variant} title={title} className="shrink-0 text-[10px] font-normal sm:text-xs">
      {eligible === false && status === "subscribed" ? "Ineligible" : RECIPIENT_STATUS_LABELS[status]}
    </Badge>
  );
}
