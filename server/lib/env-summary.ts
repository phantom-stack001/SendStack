import { summarizeRedisUrl } from "../queue/redis-url.js";

const MAIL_KEYS = [
  "AUTH_EMAIL_DELIVERY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "SPACEMAIL_SMTP_HOST",
  "SPACEMAIL_SMTP_PORT",
  "SPACEMAIL_SMTP_SECURE",
  "SPACEMAIL_IMAP_HOST",
  "SPACEMAIL_IMAP_PORT",
  "SPACEMAIL_IMAP_SECURE",
  "SPACEMAIL_EMAIL",
  "SPACEMAIL_PASSWORD",
  "SPACEMAIL_SENDER_NAME",
  "SPACEMAIL_TEST_RECIPIENT",
] as const;

let logged = false;

export function describeDatabaseTarget(databaseUrl: string) {
  try {
    const url = new URL(databaseUrl.replace(/^postgres(ql)?:/i, "http:"));
    const database = url.pathname.replace(/^\//, "");
    const sslmode = url.searchParams.get("sslmode") ?? "unset";
    return `set host=${url.hostname} port=${url.port || "5432"} db=${database || "unset"} sslmode=${sslmode}`;
  } catch {
    return "invalid";
  }
}

export function describeRedisTarget(redisUrl: string) {
  try {
    const summary = summarizeRedisUrl(redisUrl);
    return `set scheme=${summary.scheme} host=${summary.host} port=${summary.port} tls=${summary.tls}`;
  } catch {
    return "invalid";
  }
}

function presence(key: string) {
  return process.env[key]?.trim() ? "set" : "missing";
}

function secretPresence(key: string, minLength: number) {
  const value = process.env[key];
  if (!value?.trim()) return "missing";
  return value.length >= minLength ? "set" : "short";
}

function enumPresence(key: string, allowed: readonly string[]) {
  const value = process.env[key]?.trim();
  if (!value) return "missing";
  return allowed.includes(value) ? value : "set";
}

export function logSafeEnvironment() {
  if (logged) return;
  logged = true;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const redisUrl = process.env.REDIS_URL?.trim();
  console.info(
    `[startup] env DATABASE_URL=${databaseUrl ? describeDatabaseTarget(databaseUrl) : "missing"}`,
  );
  console.info(`[startup] env BETTER_AUTH_SECRET=${secretPresence("BETTER_AUTH_SECRET", 32)}`);
  console.info(`[startup] env BETTER_AUTH_URL=${describePublicOrigin("BETTER_AUTH_URL")}`);
  console.info(`[startup] env FRONTEND_URL=${describePublicOrigin("FRONTEND_URL")}`);
  console.info(`[startup] env REDIS_URL=${redisUrl ? describeRedisTarget(redisUrl) : "missing"}`);
  console.info(`[startup] env QUEUE_ENABLED=${enumPresence("QUEUE_ENABLED", ["true", "false", "1", "0"])}`);
  console.info(
    `[startup] env QUEUE_SIMULATION_ONLY=${enumPresence("QUEUE_SIMULATION_ONLY", ["true", "false", "1", "0"])}`,
  );
  const mail = MAIL_KEYS.map((key) => `${key}=${key === "AUTH_EMAIL_DELIVERY" ? enumPresence(key, ["console", "smtp", "disabled"]) : presence(key)}`).join(" ");
  console.info(`[startup] mail ${mail}`);
}

function describePublicOrigin(key: string) {
  const value = process.env[key]?.trim() ?? "";
  if (!value) return "missing";
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}
