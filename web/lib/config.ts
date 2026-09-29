import { loadEnvConfig } from "@next/env";

// Local scripts (migrate/seed/tsx) often leave NODE_ENV unset. Next then treats the
// environment as production and loads `.env.production`, which can point at a remote
// DB that is missing local migrations (e.g. daily_volume_counters from 0006).
if (!process.env.NODE_ENV) {
  (process.env as { NODE_ENV?: string }).NODE_ENV = "development";
}

// The `dev` argument is required: without it @next/env always resolves the
// production file set, so `.env.production` would win locally and point tooling
// at the production database even though NODE_ENV is "development" above.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const vercelEnv = process.env.VERCEL_ENV ?? "";
const liveSendEnabled = booleanEnv("SENDSTACK_LIVE_SEND_ENABLED", false);
const deliveryMode =
  process.env.SENDSTACK_DELIVERY_MODE?.trim().toLowerCase() ||
  (liveSendEnabled && process.env.RESEND_API_KEY ? "resend" : "sandbox");

const publicUrl = (process.env.SENDSTACK_PUBLIC_URL ?? "").trim();
const cookieSecure =
  booleanEnv("SENDSTACK_COOKIE_SECURE", false) ||
  vercelEnv === "production" ||
  publicUrl.startsWith("https://");

export const config = {
  nodeEnv,
  isVercelProduction: vercelEnv === "production",
  isVercelPreview: vercelEnv === "preview",
  get databaseUrl() {
    return process.env.DATABASE_URL ?? "";
  },
  deliveryMode,
  liveSendEnabled,
  adminEmail: process.env.SENDSTACK_ADMIN_EMAIL ?? "admin@sendstack.local",
  adminPassword: process.env.SENDSTACK_ADMIN_PASSWORD ?? "ChangeMe123!",
  defaultAdminPassword: "ChangeMe123!",
  cookieSecure,
  publicUrl: publicUrl || "http://localhost:3000",
  get dailyLimit() {
    return Number(process.env.SENDSTACK_DAILY_LIMIT ?? 50) || 50;
  },
};
