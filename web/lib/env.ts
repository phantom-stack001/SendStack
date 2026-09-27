import { identityComplianceGaps } from "./sending-identity";

function isProductionLike(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && process.env.VERCEL_ENV !== "preview")
  );
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

  // Identity/compliance settings are required whenever live sending is unlocked.
  if (
    ["1", "true", "yes", "on"].includes((process.env.SENDSTACK_LIVE_SEND_ENABLED ?? "").trim().toLowerCase())
  ) {
    const gaps = identityComplianceGaps();
    if (gaps.length) {
      throw new Error(
        `Live sending requires identity/compliance settings: ${gaps.map((gap) => gap.id).join(", ")}`,
      );
    }
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_WEBHOOK_SECRET) {
      throw new Error("Live sending requires RESEND_API_KEY and RESEND_WEBHOOK_SECRET.");
    }
  }
}

export function productionReadinessIdentityOk(): boolean {
  return identityComplianceGaps().length === 0;
}
