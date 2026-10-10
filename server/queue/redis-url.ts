const REDIS_SCHEMES = new Set(["redis:", "rediss:"]);

export type RedisUrlSummary = {
  scheme: "redis" | "rediss";
  host: string;
  port: string;
  tls: boolean;
};

export function assertRedisProtocolUrl(redisUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL.");
  }
  if (!REDIS_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      "REDIS_URL must use the Redis protocol (redis:// or rediss://). Upstash REST URLs are not supported for BullMQ.",
    );
  }
  return parsed;
}

export type RedisEndpointKind = "local" | "upstash" | "other";

export function classifyRedisEndpoint(redisUrl: string): RedisEndpointKind {
  const parsed = assertRedisProtocolUrl(redisUrl);
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "local";
  if (host.endsWith(".upstash.io")) return "upstash";
  return "other";
}

export function summarizeRedisUrl(redisUrl: string): RedisUrlSummary {
  const parsed = assertRedisProtocolUrl(redisUrl);
  return {
    scheme: parsed.protocol === "rediss:" ? "rediss" : "redis",
    host: parsed.hostname,
    port: parsed.port || (parsed.protocol === "rediss:" ? "6379" : "6379"),
    tls: parsed.protocol === "rediss:",
  };
}

/** Redact credentials for logs and CLI output. */
export function maskRedisUrl(redisUrl: string) {
  const parsed = assertRedisProtocolUrl(redisUrl);
  const user = parsed.username ? `${parsed.username}:***@` : "";
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${user}${parsed.hostname}${port}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}
