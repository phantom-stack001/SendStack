import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { QueueStatusBadge } from "@/components/queue/QueueStatusBadge";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchQueueJob, QueueApiError, retryQueueJob, type DeliveryJob } from "@/lib/queue-api";

export function QueueJobDetailsPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<DeliveryJob | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    fetchQueueJob(jobId)
      .then((res) => {
        setJob(res.job);
        setEmail(res.recipientEmail);
      })
      .catch((err) => {
        setError(err instanceof QueueApiError ? err.message : "Job not found");
      });
  }, [jobId]);

  const retry = async () => {
    if (!jobId) return;
    await retryQueueJob(jobId);
    const res = await fetchQueueJob(jobId);
    setJob(res.job);
  };

  if (!job && !error) {
    return (
      <AppPageContainer>
        <Skeleton className="h-64 w-full" />
      </AppPageContainer>
    );
  }

  return (
    <>
      <PageMeta
        title="Queue job | SendStack"
        description="Simulation job details."
        canonicalPath={`/app/queue/jobs/${jobId}/`}
      />
      <AppPageContainer>
        <PageHeader
          className="mb-4"
          title="Simulation job"
          description="Processing details (no email was sent)."
          actions={<Button asChild variant="outline"><Link to="/app/queue/">Back to queue</Link></Button>}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        {job && (
          <Card>
            <CardHeader>
              <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
                <QueueStatusBadge status={job.status} />
                <span className="min-w-0 break-all font-mono text-sm">{job.id}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>Campaign: <Link className="underline" to={`/app/campaigns/${job.campaignId}/`}>{job.campaignId}</Link></p>
              <p className="break-all">Recipient: {email ?? "—"}</p>
              <p>Attempts: {job.attemptCount}/{job.maxAttempts}</p>
              {job.lastErrorMessage && <p className="text-destructive">Last error: {job.lastErrorMessage}</p>}
              {job.skipReason && <p>Skip reason: {job.skipReason}</p>}
              {["simulation_failed", "retry_wait"].includes(job.status) && (
                <Button size="sm" variant="outline" onClick={retry}>Retry simulation</Button>
              )}
            </CardContent>
          </Card>
        )}
      </AppPageContainer>
    </>
  );
}
