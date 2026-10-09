import { Badge } from "@/components/ui/badge";
import type { DeliveryJobStatus } from "@/lib/queue-api";

const labels: Record<DeliveryJobStatus, string> = {
  pending: "Pending",
  queued: "Queued",
  processing: "Processing",
  retry_wait: "Retry wait",
  simulation_completed: "Simulated",
  simulation_failed: "Sim failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function QueueStatusBadge({ status }: { status: DeliveryJobStatus }) {
  const variant =
    status === "simulation_completed"
      ? "default"
      : status === "simulation_failed"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{labels[status] ?? status}</Badge>;
}
