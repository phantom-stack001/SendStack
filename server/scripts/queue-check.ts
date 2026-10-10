import { Queue } from "bullmq";

import { envValueSource, getEnvFileLoadResult } from "../env-files.js";
import { loadEnv } from "../env.js";
import { loadQueueEnv, QUEUE_NAMES } from "../queue/configuration.js";
import {
  closeRedisConnection,
  getRedisConnection,
  isQueueEnabled,
} from "../queue/connection.js";
import { closeQueues } from "../queue/queues.js";
import { classifyRedisEndpoint, summarizeRedisUrl } from "../queue/redis-url.js";

const runBullmqProbe = process.argv.includes("--bullmq");

function publicError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/rediss?:\/\/\S+/gi, "[redis-url]");
}

async function main() {
  loadEnv();
  const queueEnv = loadQueueEnv();
  const loaded = getEnvFileLoadResult();
  const summary: Record<string, unknown> = {
    envFiles: loaded.files,
    queueEnabled: queueEnv.QUEUE_ENABLED,
    queueEnabledSource: envValueSource("QUEUE_ENABLED"),
    simulationOnly: queueEnv.QUEUE_SIMULATION_ONLY,
    simulationOnlySource: envValueSource("QUEUE_SIMULATION_ONLY"),
    redisUrlSource: envValueSource("REDIS_URL"),
    endpointKind: null,
    connectivity: "not_tested",
    tls: null,
    bullmq: "not_tested",
  };

  if (!queueEnv.REDIS_URL?.trim()) {
    summary.connectivity = queueEnv.QUEUE_ENABLED ? "failed_missing_redis_url" : "skipped_missing_redis_url";
    if (!queueEnv.QUEUE_ENABLED) summary.note = "QUEUE_ENABLED is not true, so no Redis connection was attempted.";
    console.log(JSON.stringify(summary, null, 2));
    process.exit(queueEnv.QUEUE_ENABLED ? 1 : 0);
  }

  const urlSummary = summarizeRedisUrl(queueEnv.REDIS_URL);
  summary.endpointKind = classifyRedisEndpoint(queueEnv.REDIS_URL);
  summary.tls = urlSummary.tls;
  summary.scheme = urlSummary.scheme;
  summary.port = urlSummary.port;

  if (!queueEnv.QUEUE_ENABLED) {
    summary.connectivity = "skipped_queue_disabled";
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  if (!isQueueEnabled()) {
    summary.connectivity = "failed_invalid_configuration";
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  const redis = getRedisConnection();
  try {
    const ping = await redis.ping();
    summary.connectivity = ping === "PONG" ? "ok" : "unexpected_ping_response";
    summary.redisVersion = await redis.info("server").then((info) => {
      const line = info.split("\n").find((row) => row.startsWith("redis_version:"));
      return line?.split(":")[1]?.trim() ?? "unknown";
    });
  } catch (error) {
    summary.connectivity = "failed";
    summary.error = publicError(error, "Redis connection failed");
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  if (!runBullmqProbe) {
    summary.bullmq = "skipped_pass_--bullmq_to_probe_queues";
    console.log(JSON.stringify(summary, null, 2));
    await closeRedisConnection();
    process.exit(0);
  }

  const probeQueueName = `${QUEUE_NAMES.emailProcessing}-connectivity-probe`;
  const probeQueue = new Queue(probeQueueName, { connection: redis });
  const probeJobId = `probe-${crypto.randomUUID()}`;

  try {
    await probeQueue.add(
      "probe",
      { deliveryJobId: "probe" },
      { jobId: probeJobId, removeOnComplete: true, removeOnFail: true },
    );
    const retrieved = await probeQueue.getJob(probeJobId);
    const state = retrieved ? await retrieved.getState() : "missing";
    if (retrieved) await retrieved.remove();
    const afterRemoval = await probeQueue.getJob(probeJobId);
    summary.bullmq = retrieved && !afterRemoval && (state === "waiting" || state === "completed" || state === "delayed")
      ? "ok"
      : `unexpected_state_${state}`;
    summary.probe = {
      queue: probeQueueName,
      inserted: true,
      retrieved: Boolean(retrieved),
      removed: !afterRemoval,
      state,
    };
    summary.queues = {
      campaignDispatch: QUEUE_NAMES.campaignDispatch,
      emailProcessing: QUEUE_NAMES.emailProcessing,
    };
  } catch (error) {
    summary.bullmq = "failed";
    summary.error = publicError(error, "BullMQ probe failed");
    console.log(JSON.stringify(summary, null, 2));
    await probeQueue.close();
    await closeQueues();
    await closeRedisConnection();
    process.exit(1);
  }

  await probeQueue.close();
  await closeQueues();
  await closeRedisConnection();
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(publicError(error, "queue-check failed"));
  process.exit(1);
});
