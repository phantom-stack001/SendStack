import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "../db/index.js";
import { deliveryJobs } from "../db/schema.js";
import { isQueueEnabled } from "../queue/connection.js";
import { emailProcessingBullmqJobId } from "../queue/job-types.js";
import { getEmailProcessingQueue } from "../queue/queues.js";
import { recordQueueEvent } from "./queue-events.js";

export async function publishPendingDeliveryJobs(
  db: Database,
  campaignId: string,
  limit = 500,
) {
  if (!isQueueEnabled()) {
    throw new Error("QUEUE_DISABLED");
  }

  const pending = await db
    .select()
    .from(deliveryJobs)
    .where(
      and(
        eq(deliveryJobs.campaignId, campaignId),
        eq(deliveryJobs.status, "pending"),
        isNull(deliveryJobs.bullmqJobId),
      ),
    )
    .limit(limit);

  if (pending.length === 0) {
    return { published: 0 };
  }

  const queue = getEmailProcessingQueue();
  let published = 0;

  for (const job of pending) {
    const bullId = emailProcessingBullmqJobId(job.id);
    const delay =
      job.scheduledAt && job.scheduledAt.getTime() > Date.now()
        ? job.scheduledAt.getTime() - Date.now()
        : undefined;

    await queue.add(
      "process",
      { deliveryJobId: job.id },
      {
        jobId: bullId,
        delay,
      },
    );

    await db
      .update(deliveryJobs)
      .set({
        status: "queued",
        bullmqJobId: bullId,
        updatedAt: new Date(),
      })
      .where(eq(deliveryJobs.id, job.id));

    await recordQueueEvent(db, {
      campaignId,
      deliveryJobId: job.id,
      eventType: "job_published",
      metadata: { bullmqJobId: bullId },
    });
    published += 1;
  }

  return { published };
}

export async function reconcileOrphanedPendingJobs(db: Database, limit = 200) {
  const rows = await db
    .select({ campaignId: deliveryJobs.campaignId })
    .from(deliveryJobs)
    .where(and(eq(deliveryJobs.status, "pending"), isNull(deliveryJobs.bullmqJobId)))
    .limit(limit);

  const campaignIds = [...new Set(rows.map((r) => r.campaignId))];
  let totalPublished = 0;

  for (const campaignId of campaignIds) {
    const result = await publishPendingDeliveryJobs(db, campaignId, limit);
    totalPublished += result.published;
  }

  if (totalPublished > 0) {
    await recordQueueEvent(db, {
      eventType: "reconciliation_run",
      metadata: { published: totalPublished, campaigns: campaignIds.length },
    });
  }

  return { published: totalPublished, campaigns: campaignIds.length };
}

export async function cancelPendingJobsForCampaign(db: Database, campaignId: string) {
  await db
    .update(deliveryJobs)
    .set({
      status: "cancelled",
      updatedAt: new Date(),
      finishedAt: new Date(),
      lastErrorCode: "cancelled",
      lastErrorMessage: "Campaign cancelled",
    })
    .where(
      and(
        eq(deliveryJobs.campaignId, campaignId),
        inArray(deliveryJobs.status, ["pending", "queued", "retry_wait"]),
      ),
    );
}
