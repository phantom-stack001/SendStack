import { and, desc, eq } from "drizzle-orm";

import { parseRoleKeys } from "../auth/permissions.js";
import type { Database } from "../db/index.js";
import { adminAuditEvents, appUserAccess, user } from "../db/schema.js";
import { normalizeEmail } from "../lib/email-normalization.js";

export const MANUAL_EMAIL_VERIFICATION_ACTION = "user.email_verified_manually";

export type ManualVerifyActor = {
  id: string;
  role?: string | null;
  banned?: boolean | null;
};

export type ManualVerifyInput = {
  userId: string;
  expectedEmail: string;
  confirmed: boolean;
};

export function manualEmailVerificationAuditMetadata(email: string) {
  return {
    email,
    verificationMethod: "manual" as const,
  };
}

export type EmailVerificationView = {
  status: "verified" | "unverified";
  method: "manual" | "unknown" | null;
  verifiedAt: string | null;
  reason: string | null;
};

type TargetSnapshot = {
  id: string;
  email: string;
  emailVerified: boolean;
  role: string | null;
  banned: boolean | null;
  status: string;
};

export function manualVerifyActorError(actor: ManualVerifyActor, accessStatus = "active") {
  if (actor.banned || accessStatus === "suspended" || accessStatus === "deactivated") {
    return "This account cannot verify email addresses.";
  }
  if (!parseRoleKeys(actor.role).includes("super-admin")) {
    return "Only a super admin can verify an email address manually.";
  }
  return null;
}

export function verificationView(input: {
  emailVerified: boolean;
  email: string;
  manualEvent: { createdAt: Date; metadata: Record<string, unknown> | null } | null;
}): EmailVerificationView {
  if (!input.emailVerified) {
    return { status: "unverified", method: null, verifiedAt: null, reason: null };
  }
  const metadata = input.manualEvent?.metadata ?? null;
  const recordedEmail = typeof metadata?.email === "string" ? normalizeEmail(metadata.email) : "";
  const sameEmail = recordedEmail.length > 0 && recordedEmail === normalizeEmail(input.email);
  if (!sameEmail || !input.manualEvent) {
    return { status: "verified", method: "unknown", verifiedAt: null, reason: null };
  }
  return {
    status: "verified",
    method: "manual",
    verifiedAt: input.manualEvent.createdAt.toISOString(),
    reason: typeof metadata?.reason === "string" ? metadata.reason : null,
  };
}

/**
 * Conditional verification. The caller supplies the locked read and the
 * update that succeeds only while the reviewed address is still unverified.
 */
export async function applyManualEmailVerification(input: {
  actor: ManualVerifyActor;
  actorAccessStatus?: string;
  request: ManualVerifyInput;
  loadTarget: () => Promise<TargetSnapshot | null>;
  markVerified: (userId: string, email: string) => Promise<boolean>;
  writeAudit: (event: {
    actorUserId: string;
    targetUserId: string;
    email: string;
  }) => Promise<void>;
}) {
  const actorError = manualVerifyActorError(input.actor, input.actorAccessStatus ?? "active");
  if (actorError) return { ok: false as const, status: 403 as const, error: actorError };
  if (input.request.confirmed !== true) {
    return {
      ok: false as const,
      status: 400 as const,
      error: "Confirm that you have verified this user's email address.",
    };
  }

  const target = await input.loadTarget();
  if (!target) return { ok: false as const, status: 404 as const, error: "User not found" };
  if (normalizeEmail(target.email) !== normalizeEmail(input.request.expectedEmail)) {
    return {
      ok: false as const,
      status: 409 as const,
      error: "This account's email address changed. Review the current address before verifying.",
    };
  }
  if (target.emailVerified) {
    return { ok: false as const, status: 409 as const, error: "This email address is already verified." };
  }

  const changed = await input.markVerified(target.id, target.email);
  if (!changed) {
    return { ok: false as const, status: 409 as const, error: "This email address is already verified." };
  }

  await input.writeAudit({
    actorUserId: input.actor.id,
    targetUserId: target.id,
    email: target.email,
  });

  return {
    ok: true as const,
    user: {
      id: target.id,
      email: target.email,
      emailVerified: true,
      role: target.role,
      banned: Boolean(target.banned),
      status: target.status,
    },
  };
}

export async function manuallyVerifyUserEmail(
  db: Database,
  actor: ManualVerifyActor,
  request: ManualVerifyInput,
) {
  const [actorAccess] = await db
    .select({ status: appUserAccess.status })
    .from(appUserAccess)
    .where(eq(appUserAccess.userId, actor.id))
    .limit(1);

  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(user).where(eq(user.id, request.userId)).for("update").limit(1);
    const [access] = current
      ? await tx.select().from(appUserAccess).where(eq(appUserAccess.userId, current.id)).limit(1)
      : [];
    return applyManualEmailVerification({
      actor,
      actorAccessStatus: actorAccess?.status ?? "active",
      request,
      loadTarget: async () =>
        current
          ? {
              id: current.id,
              email: current.email,
              emailVerified: current.emailVerified,
              role: current.role,
              banned: current.banned,
              status: access?.status ?? (current.banned ? "suspended" : "active"),
            }
          : null,
      markVerified: async (userId, email) => {
        const updated = await tx
          .update(user)
          .set({ emailVerified: true, updatedAt: new Date() })
          .where(and(eq(user.id, userId), eq(user.email, email), eq(user.emailVerified, false)))
          .returning({ id: user.id });
        return updated.length === 1;
      },
      writeAudit: async (event) => {
        await tx.insert(adminAuditEvents).values({
          id: crypto.randomUUID(),
          actorUserId: event.actorUserId,
          targetUserId: event.targetUserId,
          action: MANUAL_EMAIL_VERIFICATION_ACTION,
          metadata: manualEmailVerificationAuditMetadata(event.email),
        });
      },
    });
  });
}

export async function latestManualVerification(db: Database, userId: string) {
  const [row] = await db
    .select({ createdAt: adminAuditEvents.createdAt, metadata: adminAuditEvents.metadata })
    .from(adminAuditEvents)
    .where(
      and(
        eq(adminAuditEvents.targetUserId, userId),
        eq(adminAuditEvents.action, MANUAL_EMAIL_VERIFICATION_ACTION),
      ),
    )
    .orderBy(desc(adminAuditEvents.createdAt))
    .limit(1);
  return row ?? null;
}
