import { identityComplianceGaps } from "./sending-identity";
import { loadDeliveryHealthThresholds } from "./delivery-health";
import { parsePublicOrigin, validateAllowedLinkDomains } from "./preflight";

function isProductionLike(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && process.env.VERCEL_ENV !== "preview")
  );
}

function isLiveSendEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.SENDSTACK_LIVE_SEND_ENABLED ?? "").trim().toLowerCase(),
  );
}

/**
 * Live-send prerequisites that must be complete before production live mail.
 * Returns human-readable issue strings; empty when live send is off or ready.
 * Does not affect app boot — callers log these; send paths still gate at runtime.
 */
export function liveSendBootIssues(): string[] {
  if (!isLiveSendEnabled()) {
    return [];
  }

  const issues: string[] = [];
  const gaps = identityComplianceGaps();
  if (gaps.length) {
    issues.push(
      `Live sending requires identity/compliance settings: ${gaps.map((gap) => gap.id).join(", ")}`,
    );
  }
  const smtpReady = Boolean(
    (process.env.SENDSTACK_SMTP_HOST ?? "").trim() &&
      (process.env.SENDSTACK_SMTP_USERNAME ?? "").trim() &&
      (process.env.SENDSTACK_SMTP_PASSWORD ?? "").trim(),
  );
  if (!smtpReady) {
    issues.push(
      "Live sending requires SENDSTACK_SMTP_HOST, SENDSTACK_SMTP_USERNAME, and SENDSTACK_SMTP_PASSWORD.",
    );
  }
  if (!(process.env.CRON_SECRET ?? "").trim()) {
    issues.push("Live sending requires CRON_SECRET for authenticated launch-job cron ticks.");
  }
  try {
    parsePublicOrigin(process.env.SENDSTACK_PUBLIC_URL ?? "");
  } catch (error) {
    issues.push(
      error instanceof Error
        ? error.message
        : "Live sending requires SENDSTACK_PUBLIC_URL to be a valid https:// origin.",
    );
  }
  const thresholds = loadDeliveryHealthThresholds();
  if (!thresholds.configured) {
    issues.push(
      "Live sending requires SENDSTACK_HEALTH_MIN_SAMPLE and SENDSTACK_HEALTH_MAX_*_RATE thresholds.",
    );
  }
  const domainErrors = validateAllowedLinkDomains(
    (process.env.SENDSTACK_ALLOWED_LINK_DOMAINS ?? "")
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (domainErrors.length) {
    issues.push(domainErrors[0]!);
  }
  return issues;
}

export function validateProductionEnv(): void {
  if (!isProductionLike()) {
    return;
  }

  const missing = [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["SENDSTACK_SESSION_SECRET", process.env.SENDSTACK_SESSION_SECRET],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }

  if (!sessionCookieIsSecure()) {
    throw new Error(
      "Production session cookies must be Secure, HttpOnly, and SameSite=Lax. Set SENDSTACK_COOKIE_SECURE or an https SENDSTACK_PUBLIC_URL.",
    );
  }

  const liveIssues = liveSendBootIssues();
  for (const issue of liveIssues) {
    console.error(`[sendstack] ${issue} Live send stays blocked until fixed; login and other APIs remain available.`);
  }
}

export function productionReadinessIdentityOk(): boolean {
  return identityComplianceGaps().length === 0;
}

/** True when a session cookie would carry the Secure attribute. */
export function sessionCookieIsSecure(): boolean {
  return (
    ["1", "true", "yes", "on"].includes((process.env.SENDSTACK_COOKIE_SECURE ?? "").trim().toLowerCase()) ||
    process.env.VERCEL_ENV === "production" ||
    (process.env.SENDSTACK_PUBLIC_URL ?? "").trim().startsWith("https://")
  );
}

/**
 * Production must not emit a usable session cookie unless it is Secure.
 * Callers that only clear a cookie (empty token) should not call this.
 */
export function assertProductionSessionCookie(): void {
  if (!isProductionLike()) return;
  if (!sessionCookieIsSecure()) {
    throw new Error("Refusing to issue a session cookie: production cookies must be Secure.");
  }
}
