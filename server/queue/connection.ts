import { Redis } from "ioredis";

import { loadQueueEnv } from "./configuration.js";

type RedisClient = Redis;

let sharedConnection: RedisClient | null = null;

export function getRedisConnection(): RedisClient {
  const env = loadQueueEnv();
  if (!env.QUEUE_ENABLED || !env.REDIS_URL) {
    throw new Error("QUEUE_DISABLED");
  }
  if (!sharedConnection) {
    sharedConnection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return sharedConnection;
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
    return env.QUEUE_ENABLED && Boolean(env.REDIS_URL);
  } catch {
    return false;
  }
}
