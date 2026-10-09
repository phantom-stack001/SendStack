import { ListOrdered } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { QueueJobsTable } from "@/components/queue/QueueJobsTable";
import { QueueStats } from "@/components/queue/QueueStats";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchQueueJobs, fetchQueueOverview, QueueApiError, type DeliveryJobStatus } from "@/lib/queue-api";

export function QueuePage() {
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof fetchQueueOverview>> | null>(null);
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof fetchQueueJobs>>["jobs"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DeliveryJobStatus | "">("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const fetchData = useCallback(() => {
    return Promise.all([
      fetchQueueOverview(),
      fetchQueueJobs({ page, limit: 25, status: status || undefined }),
    ]).then(([overviewRes, jobsRes]) => {
      setOverview(overviewRes);
      setJobs(jobsRes.jobs);
      setTotalPages(jobsRes.pagination.totalPages);
      setError(null);
    });
  }, [page, status]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = () => {
      fetchData()
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof QueueApiError ? err.message : "Failed to load queue");
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    load();
    timer = setInterval(load, 5000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [fetchData]);

  return (
    <>
      <PageMeta
        title="Queue | SendStack"
        description="Monitor simulated campaign processing jobs."
        canonicalPath="/app/queue/"
      />
      <AppPageContainer>
        <PageHeader
          title="Queue"
          description="Monitor and manage campaign simulation processing. No emails are sent."
        />

        {overview && (
          <p className="text-xs text-muted-foreground">
            Queue {overview.queueEnabled ? "enabled" : "disabled"} · Simulation-only mode
          </p>
        )}

        {overview && <QueueStats stats={overview.stats} />}

        <div className="flex flex-wrap gap-2">
          <select
            className="native-select sm:w-64"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as DeliveryJobStatus | "");
              setPage(1);
            }}
            aria-label="Filter by job status"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="queued">Queued</option>
            <option value="processing">Processing</option>
            <option value="simulation_completed">Simulation completed</option>
            <option value="simulation_failed">Simulation failed</option>
            <option value="skipped">Skipped</option>
          </select>
        </div>

        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <Card>
            <CardContent className="py-6 text-sm text-destructive">{error}</CardContent>
          </Card>
        ) : jobs.length === 0 ? (
          <EmptyState
            icon={ListOrdered}
            title="No simulation jobs"
            description="Activate a ready campaign from its details page to create simulation jobs."
          />
        ) : (
          <>
            <QueueJobsTable jobs={jobs} />
            {totalPages > 1 && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </AppPageContainer>
    </>
  );
}
