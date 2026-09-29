import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One authenticated launch-job tick for Vercel Hobby testing.
 * This process makes exactly one request. It has no loop, timer, or retry daemon.
 */

const RESULT_FIELDS = [
  "ok",
  "claimed",
  "launch_job_id",
  "campaign_id",
  "done",
  "advanced",
  "status",
  "chunks",
] as const;

export type TickConfig = {
  origin: string;
  secret: string;
};

function envValue(text: string, name: string): string {
  const line = text.split(/\n/).find((entry) => entry.startsWith(`${name}=`));
  if (!line) return "";
  let value = line.slice(name.length + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

export function readTickConfig(text: string): TickConfig {
  const originText = envValue(text, "SENDSTACK_PUBLIC_URL");
  const secret = envValue(text, "CRON_SECRET");
  let origin: URL;
  try {
    origin = new URL(originText);
  } catch {
    throw new Error("SENDSTACK_PUBLIC_URL must be the canonical https origin.");
  }
  if (origin.protocol !== "https:") {
    throw new Error("SENDSTACK_PUBLIC_URL must use https.");
  }
  if (!secret) {
    throw new Error("CRON_SECRET is not configured.");
  }
  return { origin: origin.origin, secret };
}

export function sanitizeTickResult(body: unknown): Record<string, unknown> {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const safe: Record<string, unknown> = {};
  for (const field of RESULT_FIELDS) {
    if (field in source) safe[field] = source[field];
  }
  return safe;
}

export async function runLaunchJobsTick(
  config: TickConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${config.origin}/api/cron/launch-jobs`, {
    method: "GET",
    redirect: "manual",
    headers: { Authorization: `Bearer ${config.secret}` },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Refusing to follow a redirect from the launch-job tick (HTTP ${response.status}).`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Launch-job tick failed with HTTP ${response.status}.`);
  }
  const body = await response.json().catch(() => ({}));
  return sanitizeTickResult(body);
}

function isDirectRun(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("launch-jobs-tick.ts") || entry.endsWith("launch-jobs-tick.js");
}

async function main(): Promise<void> {
  const text = readFileSync(resolve(process.cwd(), ".env.production"), "utf8");
  const result = await runLaunchJobsTick(readTickConfig(text));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Launch-job tick failed.";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
