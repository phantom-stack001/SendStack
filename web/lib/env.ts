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
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_WEBHOOK_SECRET) {
    issues.push("Live sending requires RESEND_API_KEY and RESEND_WEBHOOK_SECRET.");
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

  const liveIssues = liveSendBootIssues();
  for (const issue of liveIssues) {
    console.error(`[sendstack] ${issue} Live send stays blocked until fixed; login and other APIs remain available.`);
  }
}

export function productionReadinessIdentityOk(): boolean {
  return identityComplianceGaps().length === 0;
}
