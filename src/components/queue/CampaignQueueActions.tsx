import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { Campaign } from "@/lib/campaigns-api";
import {
  enqueueCampaignSimulation,
  pauseCampaignQueue,
  QueueApiError,
  resumeCampaignQueue,
} from "@/lib/queue-api";

type CampaignQueueActionsProps = {
  campaign: Campaign;
  queueEnabled: boolean;
  onUpdated?: () => void;
};

export function CampaignQueueActions({ campaign, queueEnabled, onUpdated }: CampaignQueueActionsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onUpdated?.();
    } catch (err) {
      setError(err instanceof QueueApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const canActivate = ["ready", "scheduled"].includes(campaign.status);
  const canPause = ["queued", "processing"].includes(campaign.status);
  const canResume = campaign.status === "paused";

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Simulation only — no SMTP or outbound email delivery occurs in Phase 7.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {canActivate && (
          <Button
            size="sm"
            disabled={busy || !queueEnabled}
            onClick={() => run(() => enqueueCampaignSimulation(campaign.id))}
          >
            Activate simulation queue
          </Button>
        )}
        {canPause && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => pauseCampaignQueue(campaign.id))}>
            Pause simulation
          </Button>
        )}
        {canResume && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => resumeCampaignQueue(campaign.id))}>
            Resume simulation
          </Button>
        )}
      </div>
      {!queueEnabled && (
        <p className="text-xs text-muted-foreground">
          Queue is disabled on the server (QUEUE_ENABLED=false or Redis unavailable).
        </p>
      )}
    </div>
  );
}
