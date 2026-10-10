import { Redis } from "ioredis";

import { loadQueueEnv } from "./configuration.js";
import { buildBullmqRedisOptions } from "./redis-connection-options.js";
import { maskRedisUrl } from "./redis-url.js";

type RedisClient = Redis;

let sharedConnection: RedisClient | null = null;

function sanitizeRedisError(message: string) {
  return message.replace(/rediss?:\/\/\S+/gi, "[redis-url]");
}

function attachSafeErrorLogging(client: RedisClient, label: string) {
  client.on("error", (error) => {
    const message = error instanceof Error ? error.message : "connection error";
    console.error(`[redis:${label}]`, sanitizeRedisError(message));
  });
}

function createRedisClient(redisUrl: string, label: string): RedisClient {
  const client = new Redis(redisUrl, buildBullmqRedisOptions(redisUrl));
  attachSafeErrorLogging(client, label);
  return client;
}

export function getRedisConnection(): RedisClient {
  const env = loadQueueEnv();
  if (!env.QUEUE_ENABLED || !env.REDIS_URL) {
    throw new Error("QUEUE_DISABLED");
  }
  if (!sharedConnection) {
    sharedConnection = createRedisClient(env.REDIS_URL, "shared");
  }
  return sharedConnection;
}

/**
 * BullMQ workers should use a dedicated connection (duplicate) for blocking commands.
 */
export function getWorkerRedisConnection(): RedisClient {
  const parent = getRedisConnection();
  const duplicate = parent.duplicate();
  attachSafeErrorLogging(duplicate, "worker");
  return duplicate;
}

export function describeRedisTarget() {
  const env = loadQueueEnv();
  if (!env.REDIS_URL) {
    return { enabled: env.QUEUE_ENABLED, target: null };
  }
  return {
    enabled: env.QUEUE_ENABLED,
    target: maskRedisUrl(env.REDIS_URL),
  };
}

export async function closeRedisConnection() {
  if (sharedConnection) {
    await sharedConnection.quit();
    sharedConnection = null;
  }
}

export function isQueueEnabled() {
  try {
    const env = loadQueueEnv();
    return env.QUEUE_ENABLED && Boolean(env.REDIS_URL?.trim());
  } catch {
    return false;
  }
}
