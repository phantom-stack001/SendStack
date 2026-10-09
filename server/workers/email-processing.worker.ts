import { Worker } from "bullmq";

import { createDb } from "../db/index.js";
import { deliveryJobs } from "../db/schema.js";
import { loadEnv } from "../env.js";
import { QUEUE_NAMES, loadQueueEnv } from "../queue/configuration.js";
import { closeRedisConnection, getRedisConnection } from "../queue/connection.js";
import type { EmailProcessingJobData } from "../queue/job-types.js";
import { closeQueues } from "../queue/queues.js";
import {
  persistSimulationOutcome,
  simulateDeliveryJob,
} from "../services/simulation-processor.js";
import { recordQueueEvent } from "../services/queue-events.js";
import { updateCampaignSimulationProgress } from "../services/queue-service.js";
import { eq } from "drizzle-orm";

const env = loadEnv();
const queueEnv = loadQueueEnv();
const { db, client } = createDb(env);

let worker: Worker<EmailProcessingJobData> | null = null;

async function processJob(deliveryJobId: string) {
  const [job] = await db.select().from(deliveryJobs).where(eq(deliveryJobs.id, deliveryJobId)).limit(1);
  if (!job) return;

  const attemptNumber = job.attemptCount + 1;
  const startedAt = new Date();

  await db
    .update(deliveryJobs)
    .set({
      status: "processing",
      startedAt: job.startedAt ?? startedAt,
      attemptCount: attemptNumber,
      updatedAt: startedAt,
    })
    .where(eq(deliveryJobs.id, deliveryJobId));

  await recordQueueEvent(db, {
    campaignId: job.campaignId,
    deliveryJobId,
    eventType: "job_processing_started",
    metadata: { attemptNumber },
  });

  try {
    const result = await simulateDeliveryJob(db, deliveryJobId);
    await persistSimulationOutcome(db, deliveryJobId, result, attemptNumber);
  } catch (error) {
    if (error instanceof Error && error.message === "SIMULATION_RETRY") {
      throw error;
    }
    throw error;
  }
  await updateCampaignSimulationProgress(db, job.campaignId);
}

function startWorker() {
  worker = new Worker<EmailProcessingJobData>(
    QUEUE_NAMES.emailProcessing,
    async (bullJob) => {
      await processJob(bullJob.data.deliveryJobId);
    },
    {
      connection: getRedisConnection(),
      concurrency: queueEnv.QUEUE_WORKER_CONCURRENCY,
      limiter: {
        max: queueEnv.QUEUE_MAX_JOBS_PER_SECOND,
        duration: 1000,
      },
    },
  );

  worker.on("failed", (job, error) => {
    console.error("[worker:email-processing] job failed", job?.id, error.message);
  });
}

async function shutdown(signal: string) {
  console.info(`[worker:email-processing] shutting down (${signal})`);
  await worker?.close();
  await closeQueues();
  await closeRedisConnection();
  await client.end({ timeout: 5 });
  process.exit(0);
}

if (!queueEnv.QUEUE_ENABLED) {
  console.error("QUEUE_ENABLED=false — worker not started");
  process.exit(1);
}

startWorker();
console.info("[worker:email-processing] listening");

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
