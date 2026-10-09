import { and, desc, eq, gte, lt } from "drizzle-orm";

import type { Database } from "../db/index.js";
import { mailConnectionChecks, mailSubmissions } from "../db/schema.js";
import { TEST_SEND_LIMITS } from "../mail/rate-limit.js";

export async function insertConnectionCheck(
  db: Database,
  input: {
    userId: string;
    smtpStatus: string;
    imapStatus: string;
    smtpError: string | null;
    imapError: string | null;
  },
) {
  const [row] = await db
    .insert(mailConnectionChecks)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      smtpStatus: input.smtpStatus,
      imapStatus: input.imapStatus,
      smtpError: input.smtpError,
      imapError: input.imapError,
    })
    .returning();
  return row;
}

export async function latestConnectionCheck(db: Database) {
  const [row] = await db
    .select()
    .from(mailConnectionChecks)
    .orderBy(desc(mailConnectionChecks.checkedAt))
    .limit(1);
  return row ?? null;
}

export async function latestSubmission(db: Database) {
  const [row] = await db
    .select()
    .from(mailSubmissions)
    .orderBy(desc(mailSubmissions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function expireStalePendingSubmissions(db: Database, now = new Date()) {
  await db
    .update(mailSubmissions)
    .set({
      status: "failed",
      errorMessage: "The previous test send did not finish.",
      sentCopyStatus: "not_attempted",
      updatedAt: now,
    })
    .where(
      and(
        eq(mailSubmissions.status, "pending"),
        lt(mailSubmissions.createdAt, new Date(now.getTime() - TEST_SEND_LIMITS.stalePendingMs)),
      ),
    );
}

export async function listRecentSubmissionTimes(db: Database, since: Date) {
  return db
    .select({ createdAt: mailSubmissions.createdAt })
    .from(mailSubmissions)
    .where(gte(mailSubmissions.createdAt, since));
}

export async function findSubmissionByKey(db: Database, idempotencyKey: string) {
  const [row] = await db
    .select()
    .from(mailSubmissions)
    .where(eq(mailSubmissions.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

export async function insertPendingSubmission(
  db: Database,
  input: {
    userId: string;
    idempotencyKey: string;
    fromAddress: string;
    toAddress: string;
    subject: string;
  },
) {
  const rows = await db
    .insert(mailSubmissions)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      subject: input.subject,
      status: "pending",
      acceptedRecipients: [],
      rejectedRecipients: [],
      sentCopyStatus: "not_attempted",
    })
    .onConflictDoNothing({ target: mailSubmissions.idempotencyKey })
    .returning();
  return rows[0] ?? null;
}

export async function updateSubmission(
  db: Database,
  id: string,
  patch: {
    status: string;
    messageId?: string | null;
    smtpResponse?: string | null;
    acceptedRecipients?: string[];
    rejectedRecipients?: string[];
    sentCopyStatus?: string | null;
    sentCopyError?: string | null;
    errorMessage?: string | null;
  },
) {
  const [row] = await db
    .update(mailSubmissions)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(mailSubmissions.id, id))
    .returning();
  return row ?? null;
}
