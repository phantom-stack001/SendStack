import { and, desc, eq, ilike, sql } from "drizzle-orm";

import type { Database } from "../db/index.js";
import {
  campaignRecipients,
  campaigns,
  deliveryJobs,
  queueEvents,
} from "../db/schema.js";
import { recordCampaignEvent } from "./campaign-audit.js";
import { validateCampaignContentFields } from "./campaign-content.js";
import {
  getCampaignById,
  refreshCampaignRecipientSnapshot,
} from "./campaigns.js";
import { isQueueEnabled } from "../queue/connection.js";
import { loadQueueEnv } from "../queue/configuration.js";
import { campaignDispatchBullmqJobId } from "../queue/job-types.js";
import { getCampaignDispatchQueue } from "../queue/queues.js";
import { recordQueueEvent } from "./queue-events.js";
import {
  cancelPendingJobsForCampaign,
  publishPendingDeliveryJobs,
} from "./queue-reconciliation.js";
import type { CampaignStatus } from "../validation/campaigns.js";

const ENQUEUEABLE_STATUSES: CampaignStatus[] = ["ready", "scheduled"];
const ACTIVE_QUEUE_STATUSES: CampaignStatus[] = ["queued", "processing", "paused"];

export function serializeDeliveryJob(row: typeof deliveryJobs.$inferSelect) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    campaignRecipientId: row.campaignRecipientId,
    userId: row.userId,
    status: row.status,
    bullmqJobId: row.bullmqJobId,
    queueGeneration: row.queueGeneration,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    skipReason: row.skipReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getQueueOverview(db: Database, userId: string) {
  const rows = await db
    .select({
      status: deliveryJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(deliveryJobs)
    .where(eq(deliveryJobs.userId, userId))
    .groupBy(deliveryJobs.status);

  const stats = {
    pending: 0,
    queued: 0,
    processing: 0,
    simulation_completed: 0,
    simulation_failed: 0,
    skipped: 0,
    retry_wait: 0,
    cancelled: 0,
    total: 0,
  };

  for (const row of rows) {
    stats.total += row.count;
    const key = row.status as keyof typeof stats;
    if (key in stats && key !== "total") {
      stats[key] = row.count;
    }
  }

  return { stats, queueEnabled: isQueueEnabled(), simulationOnly: true };
}

export async function listDeliveryJobs(
  db: Database,
  userId: string,
  options: {
    page: number;
    limit: number;
    status?: string;
    q?: string;
    campaignId?: string;
  },
) {
  const conditions = [eq(deliveryJobs.userId, userId)];
  if (options.status) conditions.push(eq(deliveryJobs.status, options.status));
  if (options.campaignId) conditions.push(eq(deliveryJobs.campaignId, options.campaignId));
  if (options.q?.trim()) {
    conditions.push(ilike(deliveryJobs.id, `%${options.q.trim()}%`));
  }

  const whereClause = and(...conditions);
  const offset = (options.page - 1) * options.limit;

  const [rows, countRow, recipientRows] = await Promise.all([
    db
      .select()
      .from(deliveryJobs)
      .where(whereClause)
      .orderBy(desc(deliveryJobs.updatedAt))
      .limit(options.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryJobs)
      .where(whereClause),
    db
      .select({
        jobId: deliveryJobs.id,
        email: campaignRecipients.email,
      })
      .from(deliveryJobs)
      .innerJoin(campaignRecipients, eq(deliveryJobs.campaignRecipientId, campaignRecipients.id))
      .where(whereClause),
  ]);

  const emailByJob = new Map(recipientRows.map((r) => [r.jobId, r.email]));
  const total = countRow[0]?.count ?? 0;

  return {
    jobs: rows.map((row) => ({
      ...serializeDeliveryJob(row),
      recipientEmail: emailByJob.get(row.id) ?? null,
    })),
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    },
  };
}

export async function getDeliveryJobDetail(db: Database, userId: string, jobId: string) {
  const [row] = await db
    .select()
    .from(deliveryJobs)
    .where(and(eq(deliveryJobs.id, jobId), eq(deliveryJobs.userId, userId)))
    .limit(1);
  if (!row) return null;

  const [recipient] = await db
    .select()
    .from(campaignRecipients)
    .where(eq(campaignRecipients.id, row.campaignRecipientId))
    .limit(1);

  const events = await db
    .select()
    .from(queueEvents)
    .where(eq(queueEvents.deliveryJobId, jobId))
    .orderBy(desc(queueEvents.createdAt))
    .limit(20);

  return {
    job: serializeDeliveryJob(row),
    recipientEmail: recipient?.email ?? null,
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      metadata: e.metadata ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export async function enqueueCampaignForSimulation(
  db: Database,
  userId: string,
  campaignId: string,
) {
  if (!isQueueEnabled()) {
    throw new Error("QUEUE_DISABLED");
  }

  const env = loadQueueEnv();
  const campaign = await getCampaignById(db, userId, campaignId);
  if (!campaign) return null;

  if (ACTIVE_QUEUE_STATUSES.includes(campaign.status as CampaignStatus)) {
    const existing = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryJobs)
      .where(
        and(
          eq(deliveryJobs.campaignId, campaignId),
          eq(deliveryJobs.queueGeneration, campaign.queueGeneration),
        ),
      );
    return {
      campaign,
      created: 0,
      totalJobs: existing[0]?.count ?? 0,
      idempotent: true,
    };
  }

  if (!ENQUEUEABLE_STATUSES.includes(campaign.status as CampaignStatus)) {
    throw new Error("NOT_ENQUEUEABLE");
  }

  const contentIssues = validateCampaignContentFields({
    senderName: campaign.senderName,
    senderEmail: campaign.senderEmail,
    subject: campaign.subject,
    bodyHtml: campaign.bodyHtml,
    bodyText: campaign.bodyText,
  });
  if (contentIssues.length > 0) {
    throw new Error("INVALID_CONTENT");
  }

  const summary = await refreshCampaignRecipientSnapshot(db, userId, campaignId);
  if (!summary) return null;
  const eligibleRecipientRows = await db
    .select()
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.eligibilityStatus, "eligible"),
      ),
    );

  if (eligibleRecipientRows.length === 0) {
    throw new Error("NO_ELIGIBLE_RECIPIENTS");
  }

  const nextGeneration = campaign.queueGeneration + 1;
  const now = new Date();
  const dispatchAt =
    campaign.scheduledAt && campaign.scheduledAt.getTime() > now.getTime()
      ? campaign.scheduledAt
      : now;

  const createdJobs = await db.transaction(async (tx) => {
    const [updatedCampaign] = await tx
      .update(campaigns)
      .set({
        queueGeneration: nextGeneration,
        queuePaused: false,
        status: "queued",
        enqueuedAt: now,
        revision: campaign.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
      .returning();

    if (!updatedCampaign) throw new Error("UPDATE_FAILED");

    const jobValues = eligibleRecipientRows.map((recipient) => ({
      id: crypto.randomUUID(),
      campaignId,
      campaignRecipientId: recipient.id,
      userId,
      status: "pending" as const,
      queueGeneration: nextGeneration,
      maxAttempts: env.QUEUE_MAX_ATTEMPTS,
      scheduledAt: dispatchAt,
    }));

    await tx.insert(deliveryJobs).values(jobValues);

    await recordCampaignEvent(tx, {
      campaignId,
      actorUserId: userId,
      eventType: "campaign_updated",
      metadata: { action: "enqueue_simulation", jobs: jobValues.length, generation: nextGeneration },
    });

    await recordQueueEvent(tx, {
      campaignId,
      actorUserId: userId,
      eventType: "campaign_enqueued",
      metadata: {
        generation: nextGeneration,
        jobs: jobValues.length,
        simulationOnly: true,
      },
    });

    return jobValues.length;
  });

  const delay = Math.max(0, dispatchAt.getTime() - Date.now());
  const dispatchQueue = getCampaignDispatchQueue();
  await dispatchQueue.add(
    "dispatch",
    { campaignId },
    {
      jobId: campaignDispatchBullmqJobId(campaignId, nextGeneration),
      delay,
    },
  );

  const refreshed = await getCampaignById(db, userId, campaignId);
  return {
    campaign: refreshed,
    created: createdJobs,
    totalJobs: createdJobs,
    idempotent: false,
    eligibilitySummary: summary,
  };
}

export async function dispatchCampaignJobs(db: Database, campaignId: string) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
  if (campaign.status === "cancelled") return { published: 0 };
  if (campaign.queuePaused) return { published: 0 };

  await db
    .update(campaigns)
    .set({ status: "processing", updatedAt: new Date() })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "queued")));

  const result = await publishPendingDeliveryJobs(db, campaignId);
  await recordQueueEvent(db, {
    campaignId,
    eventType: "campaign_dispatch_completed",
    metadata: result,
  });
  return result;
}

export async function updateCampaignSimulationProgress(db: Database, campaignId: string) {
  const counts = await db
    .select({
      status: deliveryJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(deliveryJobs)
    .where(eq(deliveryJobs.campaignId, campaignId))
    .groupBy(deliveryJobs.status);

  const byStatus = new Map(counts.map((c) => [c.status, c.count]));
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const terminal =
    (byStatus.get("simulation_completed") ?? 0) +
    (byStatus.get("simulation_failed") ?? 0) +
    (byStatus.get("skipped") ?? 0) +
    (byStatus.get("cancelled") ?? 0);

  if (total > 0 && terminal >= total) {
    const failed = byStatus.get("simulation_failed") ?? 0;
    const nextStatus = failed > 0 ? "simulation_failed" : "simulation_completed";
    await db
      .update(campaigns)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));
  }
}

export async function pauseCampaignQueue(db: Database, userId: string, campaignId: string) {
  const campaign = await getCampaignById(db, userId, campaignId);
  if (!campaign) return null;
  if (!["queued", "processing"].includes(campaign.status)) {
    throw new Error("NOT_PAUSABLE");
  }

  const [row] = await db
    .update(campaigns)
    .set({
      queuePaused: true,
      status: "paused",
      revision: campaign.revision + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .returning();

  await recordQueueEvent(db, {
    campaignId,
    actorUserId: userId,
    eventType: "campaign_paused",
  });

  return row ?? null;
}

export async function resumeCampaignQueue(db: Database, userId: string, campaignId: string) {
  const campaign = await getCampaignById(db, userId, campaignId);
  if (!campaign) return null;
  if (campaign.status !== "paused") {
    throw new Error("NOT_RESUMABLE");
  }

  const [row] = await db
    .update(campaigns)
    .set({
      queuePaused: false,
      status: "queued",
      revision: campaign.revision + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .returning();

  await recordQueueEvent(db, {
    campaignId,
    actorUserId: userId,
    eventType: "campaign_resumed",
  });

  if (isQueueEnabled()) {
    const dispatchQueue = getCampaignDispatchQueue();
    await dispatchQueue.add(
      "dispatch",
      { campaignId },
      { jobId: campaignDispatchBullmqJobId(campaignId, campaign.queueGeneration) },
    );
  }

  return row ?? null;
}

export async function cancelCampaignQueue(db: Database, userId: string, campaignId: string) {
  const campaign = await getCampaignById(db, userId, campaignId);
  if (!campaign) return null;

  const cancellable = [
    "draft",
    "ready",
    "scheduled",
    "queued",
    "processing",
    "paused",
  ];
  if (!cancellable.includes(campaign.status)) {
    throw new Error("NOT_CANCELLABLE");
  }

  await cancelPendingJobsForCampaign(db, campaignId);

  const [row] = await db
    .update(campaigns)
    .set({
      status: "cancelled",
      queuePaused: false,
      revision: campaign.revision + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .returning();

  await recordCampaignEvent(db, {
    campaignId,
    actorUserId: userId,
    eventType: "campaign_cancelled",
    metadata: { source: "queue_cancel" },
  });

  await recordQueueEvent(db, {
    campaignId,
    actorUserId: userId,
    eventType: "campaign_queue_cancelled",
  });

  return row ?? null;
}

export async function retryDeliveryJob(db: Database, userId: string, jobId: string) {
  if (!isQueueEnabled()) throw new Error("QUEUE_DISABLED");

  const [job] = await db
    .select()
    .from(deliveryJobs)
    .where(and(eq(deliveryJobs.id, jobId), eq(deliveryJobs.userId, userId)))
    .limit(1);

  if (!job) return null;
  if (!["simulation_failed", "retry_wait"].includes(job.status)) {
    throw new Error("NOT_RETRYABLE");
  }

  await db
    .update(deliveryJobs)
    .set({
      status: "pending",
      bullmqJobId: null,
      updatedAt: new Date(),
      finishedAt: null,
    })
    .where(eq(deliveryJobs.id, jobId));

  await publishPendingDeliveryJobs(db, job.campaignId, 1);

  await recordQueueEvent(db, {
    campaignId: job.campaignId,
    deliveryJobId: jobId,
    actorUserId: userId,
    eventType: "job_retry_requested",
  });

  const [updated] = await db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
  return updated ?? null;
}

export async function getCampaignQueueSummary(db: Database, userId: string, campaignId: string) {
  const campaign = await getCampaignById(db, userId, campaignId);
  if (!campaign) return null;

  const counts = await db
    .select({
      status: deliveryJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(deliveryJobs)
    .where(eq(deliveryJobs.campaignId, campaignId))
    .groupBy(deliveryJobs.status);

  return {
    campaign: {
      id: campaign.id,
      status: campaign.status,
      queuePaused: campaign.queuePaused,
      queueGeneration: campaign.queueGeneration,
      enqueuedAt: campaign.enqueuedAt?.toISOString() ?? null,
    },
    jobCounts: counts,
    simulationOnly: true,
  };
}

export async function listQueueEvents(
  db: Database,
  userId: string,
  options: { campaignId?: string; limit: number },
) {
  if (options.campaignId) {
    const owned = await getCampaignById(db, userId, options.campaignId);
    if (!owned) return null;
  }

  const events = await db
    .select({
      id: queueEvents.id,
      campaignId: queueEvents.campaignId,
      deliveryJobId: queueEvents.deliveryJobId,
      eventType: queueEvents.eventType,
      metadata: queueEvents.metadata,
      createdAt: queueEvents.createdAt,
    })
    .from(queueEvents)
    .innerJoin(campaigns, eq(queueEvents.campaignId, campaigns.id))
    .where(
      options.campaignId
        ? and(
            eq(campaigns.userId, userId),
            eq(queueEvents.campaignId, options.campaignId),
          )
        : eq(campaigns.userId, userId),
    )
    .orderBy(desc(queueEvents.createdAt))
    .limit(options.limit);

  return events.map((e) => ({
    id: e.id,
    campaignId: e.campaignId,
    deliveryJobId: e.deliveryJobId,
    eventType: e.eventType,
    metadata: e.metadata ?? null,
    createdAt: e.createdAt.toISOString(),
  }));
}
