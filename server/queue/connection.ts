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

export async function probeRedis(): Promise<"ok" | "unavailable" | "disabled"> {
  let redisUrl: string | undefined;
  try {
    const env = loadQueueEnv();
    if (!env.QUEUE_ENABLED || !env.REDIS_URL?.trim()) return "disabled";
    redisUrl = env.REDIS_URL;
  } catch (error) {
    console.error("[health] redis", error instanceof Error ? error.name : "Error");
    return "unavailable";
  }

  const client = new Redis(redisUrl, {
    ...buildBullmqRedisOptions(redisUrl),
    connectTimeout: 4_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
    enableReadyCheck: false,
  });
  attachSafeErrorLogging(client, "health");
  try {
    await client.connect();
    const pong = await client.ping();
    return pong === "PONG" ? "ok" : "unavailable";
  } catch (error) {
    console.error("[health] redis", error instanceof Error ? error.name : "Error");
    return "unavailable";
  } finally {
    client.disconnect();
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
