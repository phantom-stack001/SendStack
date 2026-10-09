import { Badge } from "@/components/ui/badge";
import type { CampaignStatus } from "@/lib/campaigns-api";

const labels: Record<CampaignStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  scheduled: "Scheduled",
  queued: "Queued",
  processing: "Processing",
  paused: "Paused",
  simulation_completed: "Simulated",
  simulation_failed: "Sim failed",
  sending: "Sending",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function variant(status: CampaignStatus) {
  if (status === "draft") return "secondary" as const;
  if (status === "ready") return "default" as const;
  if (status === "scheduled") return "outline" as const;
  if (status === "cancelled") return "destructive" as const;
  return "secondary" as const;
}

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge variant={variant(status)}>{labels[status] ?? status}</Badge>;
}
