import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../db/index.js";
import { emailDrafts } from "../db/schema.js";
import { DRAFT_LIMITS } from "../validation/drafts.js";
import { processDraftContent } from "../lib/email-content.js";

export type DraftRecord = typeof emailDrafts.$inferSelect;

export function serializeDraft(row: DraftRecord) {
  return {
    id: row.id,
    senderName: row.senderName,
    senderEmail: row.senderEmail,
    subject: row.subject,
    contentJson: row.contentJson,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type DraftInput = {
  senderName?: string;
  senderEmail?: string;
  subject?: string;
  contentJson?: unknown;
};

function normalizeFields(input: DraftInput) {
  return {
    senderName: input.senderName?.trim() ?? "",
    senderEmail: input.senderEmail?.trim() ?? "",
    subject: input.subject?.trim() ?? "",
  };
}

export async function createEmailDraft(
  db: Database,
  userId: string,
  input: DraftInput,
) {
  const fields = normalizeFields(input);
  const content = processDraftContent(input.contentJson);

  if (content.bodyHtml.length > DRAFT_LIMITS.bodyHtmlMaxBytes) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }

  const id = crypto.randomUUID();
  const [row] = await db
    .insert(emailDrafts)
    .values({
      id,
      userId,
      senderName: fields.senderName,
      senderEmail: fields.senderEmail,
      subject: fields.subject,
      contentJson: content.contentJson,
      bodyHtml: content.bodyHtml,
      bodyText: content.bodyText,
    })
    .returning();

  if (!row) {
    throw new Error("CREATE_FAILED");
  }

  return row;
}

export async function listEmailDrafts(
  db: Database,
  userId: string,
  page: number,
  limit: number,
) {
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(emailDrafts)
      .where(eq(emailDrafts.userId, userId))
      .orderBy(desc(emailDrafts.updatedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailDrafts)
      .where(eq(emailDrafts.userId, userId)),
  ]);

  const total = countRow[0]?.count ?? 0;

  return {
    drafts: rows.map(serializeDraft),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

export async function getEmailDraftById(db: Database, userId: string, draftId: string) {
  const [row] = await db
    .select()
    .from(emailDrafts)
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, userId)))
    .limit(1);

  return row ?? null;
}

export async function updateEmailDraft(
  db: Database,
  userId: string,
  draftId: string,
  input: DraftInput,
) {
  const existing = await getEmailDraftById(db, userId, draftId);
  if (!existing) {
    return null;
  }

  const fields = normalizeFields({
    senderName: input.senderName ?? existing.senderName,
    senderEmail: input.senderEmail ?? existing.senderEmail,
    subject: input.subject ?? existing.subject,
  });

  const content = processDraftContent(
    input.contentJson !== undefined ? input.contentJson : existing.contentJson,
  );

  if (content.bodyHtml.length > DRAFT_LIMITS.bodyHtmlMaxBytes) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }

  const [row] = await db
    .update(emailDrafts)
    .set({
      senderName: fields.senderName,
      senderEmail: fields.senderEmail,
      subject: fields.subject,
      contentJson: content.contentJson,
      bodyHtml: content.bodyHtml,
      bodyText: content.bodyText,
      updatedAt: new Date(),
    })
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, userId)))
    .returning();

  return row ?? null;
}

export async function deleteEmailDraft(db: Database, userId: string, draftId: string) {
  const [row] = await db
    .delete(emailDrafts)
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, userId)))
    .returning({ id: emailDrafts.id });

  return row ?? null;
}
