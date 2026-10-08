import { config } from "./config";

function emergencyStopEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.SENDSTACK_EMERGENCY_STOP ?? "").trim().toLowerCase(),
  );
}

export function smtpConfigured(): boolean {
  return Boolean(
    (process.env.SENDSTACK_SMTP_HOST ?? "").trim() &&
      (process.env.SENDSTACK_SMTP_USERNAME ?? "").trim() &&
      (process.env.SENDSTACK_SMTP_PASSWORD ?? "").trim(),
  );
}

/**
 * Live sending is allowed only when the kill switch is on, SMTP is configured,
 * emergency stop is off, and the runtime is not preview/test.
 */
export function liveSendAllowed(): boolean {
  if (config.isVercelPreview) return false;
  if (config.nodeEnv === "test") return false;
  if (emergencyStopEnabled()) return false;
  return Boolean(config.liveSendEnabled && config.deliveryMode === "smtp" && smtpConfigured());
}

export function providerTimeoutMs(): number {
  return Number(process.env.SENDSTACK_PROVIDER_TIMEOUT_MS ?? 8_000) || 8_000;
}

export function smtpHourlyLimit(): number {
  return Number(process.env.SENDSTACK_SMTP_HOURLY_LIMIT ?? 500) || 500;
}

export function buildIdempotencyKey(parts: string[]): string {
  return parts.join(":").slice(0, 256);
}
