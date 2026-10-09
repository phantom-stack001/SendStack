import { Queue } from "bullmq";

import { bullmqJobRetentionMs, loadQueueEnv, QUEUE_NAMES } from "./configuration.js";
import { getRedisConnection, isQueueEnabled } from "./connection.js";
import type { CampaignDispatchJobData, EmailProcessingJobData } from "./job-types.js";

let campaignDispatchQueue: Queue<CampaignDispatchJobData> | null = null;
let emailProcessingQueue: Queue<EmailProcessingJobData> | null = null;

function defaultJobOptions() {
  const env = loadQueueEnv();
  return {
    removeOnComplete: { age: bullmqJobRetentionMs(env.QUEUE_JOB_RETENTION_DAYS) },
    removeOnFail: { age: bullmqJobRetentionMs(env.QUEUE_JOB_RETENTION_DAYS) },
    attempts: env.QUEUE_MAX_ATTEMPTS,
    backoff: { type: "exponential" as const, delay: 2000 },
  };
}

export function getCampaignDispatchQueue() {
  if (!isQueueEnabled()) throw new Error("QUEUE_DISABLED");
  if (!campaignDispatchQueue) {
    campaignDispatchQueue = new Queue<CampaignDispatchJobData>(QUEUE_NAMES.campaignDispatch, {
      connection: getRedisConnection(),
      defaultJobOptions: defaultJobOptions(),
    });
  }
  return campaignDispatchQueue;
}

export function getEmailProcessingQueue() {
  if (!isQueueEnabled()) throw new Error("QUEUE_DISABLED");
  if (!emailProcessingQueue) {
    emailProcessingQueue = new Queue<EmailProcessingJobData>(QUEUE_NAMES.emailProcessing, {
      connection: getRedisConnection(),
      defaultJobOptions: defaultJobOptions(),
    });
  }
  return emailProcessingQueue;
}

export async function closeQueues() {
  await Promise.all([
    campaignDispatchQueue?.close(),
    emailProcessingQueue?.close(),
  ]);
  campaignDispatchQueue = null;
  emailProcessingQueue = null;
}
