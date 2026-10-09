import { Link } from "react-router-dom";

import { QueueStatusBadge } from "@/components/queue/QueueStatusBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DeliveryJob } from "@/lib/queue-api";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

export function QueueJobsTable({ jobs }: { jobs: DeliveryJob[] }) {
  return (
    <>
      <ul className="divide-y md:hidden">
        {jobs.map((job) => (
          <li key={job.id} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link className="font-medium hover:underline" to={`/app/queue/jobs/${job.id}/`}>
                Job {job.id.slice(0, 8)}…
              </Link>
              <QueueStatusBadge status={job.status} />
            </div>
            <p className="wrap-break-word">{job.recipientEmail ?? "No recipient"}</p>
            <p className="text-xs text-muted-foreground">
              {job.attemptCount}/{job.maxAttempts} attempts · {formatDate(job.updatedAt)}
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Job</TableHead>
          <TableHead>Campaign</TableHead>
          <TableHead>Recipient</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Attempts</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell className="font-mono text-xs">
              <Link className="hover:underline" to={`/app/queue/jobs/${job.id}/`}>
                {job.id.slice(0, 8)}…
              </Link>
            </TableCell>
            <TableCell>
              <Link className="hover:underline" to={`/app/campaigns/${job.campaignId}/`}>
                {job.campaignId.slice(0, 8)}…
              </Link>
            </TableCell>
            <TableCell className="max-w-56 truncate">{job.recipientEmail ?? "—"}</TableCell>
            <TableCell>
              <QueueStatusBadge status={job.status} />
            </TableCell>
            <TableCell className="tabular-nums">
              {job.attemptCount}/{job.maxAttempts}
            </TableCell>
            <TableCell>{formatDate(job.updatedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
      </div>
    </>
  );
}
