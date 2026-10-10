import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { Database } from "../db/index.js";
import { individualEmailSubmissions } from "../db/schema.js";
import type { StoredSendStatus } from "../mail/direct-send-policy.js";

export type IndividualSubmissionRow = typeof individualEmailSubmissions.$inferSelect;

export async function findIndividualSubmission(db: Database, idempotencyKey: string) {
  const [row] = await db
    .select()
    .from(individualEmailSubmissions)
    .where(eq(individualEmailSubmissions.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

export async function insertIndividualSubmission(
  db: Database,
  input: {
    userId: string;
    sourceDraftId: string | null;
    idempotencyKey: string;
    senderEmail: string;
    toRecipients: string[];
    ccRecipients: string[];
    bccRecipients: string[];
    recipientSummary: string;
    subject: string;
  },
) {
  const rows = await db
    .insert(individualEmailSubmissions)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      sourceDraftId: input.sourceDraftId,
      idempotencyKey: input.idempotencyKey,
      senderEmail: input.senderEmail,
      toRecipients: input.toRecipients,
      ccRecipients: input.ccRecipients,
      bccRecipients: input.bccRecipients,
      recipientSummary: input.recipientSummary,
      subject: input.subject,
      status: "pending",
      sentCopyStatus: "not_attempted",
    })
    .onConflictDoNothing({ target: individualEmailSubmissions.idempotencyKey })
    .returning();
  return rows[0] ?? null;
}

export async function updateIndividualSubmission(
  db: Database,
  id: string,
  patch: {
    status: StoredSendStatus;
    messageId?: string | null;
    smtpAcceptedAt?: Date | null;
    sentCopySavedAt?: Date | null;
    sentCopyStatus?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
) {
  const [row] = await db
    .update(individualEmailSubmissions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(individualEmailSubmissions.id, id))
    .returning();
  return row ?? null;
}

export async function listRecentIndividualSubmissionTimes(db: Database, userId: string, since: Date) {
  return db
    .select({ createdAt: individualEmailSubmissions.createdAt })
    .from(individualEmailSubmissions)
    .where(
      and(eq(individualEmailSubmissions.userId, userId), gte(individualEmailSubmissions.createdAt, since)),
    );
}

export async function listIndividualSubmissions(db: Database, userId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;
  const where = eq(individualEmailSubmissions.userId, userId);
  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(individualEmailSubmissions)
      .where(where)
      .orderBy(desc(individualEmailSubmissions.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(individualEmailSubmissions)
      .where(where),
  ]);
  return { rows, total: countRow[0]?.total ?? 0 };
}
