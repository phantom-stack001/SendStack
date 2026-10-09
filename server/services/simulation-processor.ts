import { and, eq } from "drizzle-orm";

import type { Database } from "../db/index.js";
import {
  campaignRecipients,
  campaigns,
  contacts,
  deliveryJobAttempts,
  deliveryJobs,
  emailSuppressions,
} from "../db/schema.js";
import { classifyContactEligibility, type ContactCandidate } from "./campaign-eligibility.js";
import { loadQueueEnv } from "../queue/configuration.js";
import { recordQueueEvent } from "./queue-events.js";

export type SimulationSkipReason =
  | "campaign_cancelled"
  | "campaign_paused"
  | "recipient_ineligible"
  | "contact_missing"
  | "simulation_disabled";

export type SimulationResult =
  | { outcome: "completed" }
  | { outcome: "skipped"; reason: SimulationSkipReason; message: string }
  | { outcome: "failed"; code: string; message: string; retryable: boolean };

export async function recheckRecipientEligibility(
  db: Database,
  userId: string,
  campaignRecipientId: string,
): Promise<{ eligible: boolean; reason: string; email: string }> {
  const [recipient] = await db
    .select()
    .from(campaignRecipients)
    .where(eq(campaignRecipients.id, campaignRecipientId))
    .limit(1);

  if (!recipient) {
    return { eligible: false, reason: "recipient_missing", email: "" };
  }

  if (!recipient.contactId) {
    return { eligible: false, reason: "contact_missing", email: recipient.email };
  }

  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, recipient.contactId), eq(contacts.userId, userId)))
    .limit(1);

  if (!contact) {
    return { eligible: false, reason: "contact_missing", email: recipient.email };
  }

  const [suppression] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(and(eq(emailSuppressions.userId, userId), eq(emailSuppressions.email, contact.email)))
    .limit(1);

  const suppressed = new Set(suppression ? [contact.email] : []);
  const candidate: ContactCandidate = {
    contactId: contact.id,
    email: contact.email,
    subscriptionStatus: contact.subscriptionStatus as ContactCandidate["subscriptionStatus"],
  };
  const row = classifyContactEligibility(candidate, suppressed);
  return {
    eligible: row.eligibilityStatus === "eligible",
    reason: row.eligibilityReason,
    email: row.email,
  };
}

export async function simulateDeliveryJob(
  db: Database,
  deliveryJobId: string,
): Promise<SimulationResult> {
  const env = loadQueueEnv();
  if (!env.QUEUE_SIMULATION_ONLY) {
    return {
      outcome: "failed",
      code: "simulation_disabled",
      message: "Simulation-only mode is required",
      retryable: false,
    };
  }

  const [job] = await db.select().from(deliveryJobs).where(eq(deliveryJobs.id, deliveryJobId)).limit(1);
  if (!job) {
    return { outcome: "failed", code: "job_not_found", message: "Job not found", retryable: false };
  }

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, job.campaignId))
    .limit(1);

  if (!campaign) {
    return { outcome: "failed", code: "campaign_not_found", message: "Campaign not found", retryable: false };
  }

  if (campaign.status === "cancelled") {
    return {
      outcome: "skipped",
      reason: "campaign_cancelled",
      message: "Campaign was cancelled",
    };
  }

  if (campaign.queuePaused) {
    return {
      outcome: "skipped",
      reason: "campaign_paused",
      message: "Campaign is paused",
    };
  }

  const eligibility = await recheckRecipientEligibility(db, job.userId, job.campaignRecipientId);
  if (!eligibility.eligible) {
    return {
      outcome: "skipped",
      reason: "recipient_ineligible",
      message: eligibility.reason,
    };
  }

  if (env.QUEUE_SIMULATION_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, env.QUEUE_SIMULATION_DELAY_MS));
  }

  const forcedFailure = process.env.QUEUE_SIMULATION_FORCE_FAIL === "1";
  if (forcedFailure) {
    return {
      outcome: "failed",
      code: "simulated_transient",
      message: "Controlled simulation failure",
      retryable: true,
    };
  }

  return { outcome: "completed" };
}

export async function persistSimulationOutcome(
  db: Database,
  deliveryJobId: string,
  result: SimulationResult,
  attemptNumber: number,
) {
  const now = new Date();
  const attemptId = crypto.randomUUID();

  if (result.outcome === "completed") {
    await db.insert(deliveryJobAttempts).values({
      id: attemptId,
      deliveryJobId,
      attemptNumber,
      status: "simulation_completed",
      startedAt: now,
      finishedAt: now,
    });
    await db
      .update(deliveryJobs)
      .set({
        status: "simulation_completed",
        attemptCount: attemptNumber,
        finishedAt: now,
        updatedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
      })
      .where(eq(deliveryJobs.id, deliveryJobId));
    await recordQueueEvent(db, {
      deliveryJobId,
      eventType: "job_simulation_completed",
      metadata: { attemptNumber },
    });
    return;
  }

  if (result.outcome === "skipped") {
    await db.insert(deliveryJobAttempts).values({
      id: attemptId,
      deliveryJobId,
      attemptNumber,
      status: "skipped",
      startedAt: now,
      finishedAt: now,
      errorCode: result.reason,
      errorMessage: result.message,
    });
    await db
      .update(deliveryJobs)
      .set({
        status: "skipped",
        skipReason: result.reason,
        attemptCount: attemptNumber,
        finishedAt: now,
        updatedAt: now,
        lastErrorCode: result.reason,
        lastErrorMessage: result.message,
      })
      .where(eq(deliveryJobs.id, deliveryJobId));
    await recordQueueEvent(db, {
      deliveryJobId,
      eventType: "job_skipped",
      metadata: { reason: result.reason },
    });
    return;
  }

  await db.insert(deliveryJobAttempts).values({
    id: attemptId,
    deliveryJobId,
    attemptNumber,
    status: "simulation_failed",
    startedAt: now,
    finishedAt: now,
    errorCode: result.code,
    errorMessage: result.message,
  });

  const [job] = await db.select().from(deliveryJobs).where(eq(deliveryJobs.id, deliveryJobId)).limit(1);
  const maxAttempts = job?.maxAttempts ?? 3;
  const terminal = !result.retryable || attemptNumber >= maxAttempts;

  await db
    .update(deliveryJobs)
    .set({
      status: terminal ? "simulation_failed" : "retry_wait",
      attemptCount: attemptNumber,
      finishedAt: terminal ? now : null,
      updatedAt: now,
      lastErrorCode: result.code,
      lastErrorMessage: result.message,
    })
    .where(eq(deliveryJobs.id, deliveryJobId));

  await recordQueueEvent(db, {
    deliveryJobId,
    eventType: "job_simulation_failed",
    metadata: { code: result.code, retryable: result.retryable, terminal },
  });

  if (!terminal) {
    throw new Error("SIMULATION_RETRY");
  }
}
