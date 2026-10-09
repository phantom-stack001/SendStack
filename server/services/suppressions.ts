import { and, desc, eq, ilike, sql } from "drizzle-orm";

import type { Database } from "../db/index.js";
import { contacts, emailSuppressions } from "../db/schema.js";
import { normalizeEmail } from "../lib/email-normalization.js";
import type { SUPPRESSION_REASONS } from "../validation/contacts.js";

type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export function serializeSuppression(row: typeof emailSuppressions.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    reason: row.reason as SuppressionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSuppressions(
  db: Database,
  userId: string,
  options: { page: number; limit: number; q?: string; reason?: SuppressionReason },
) {
  const conditions = [eq(emailSuppressions.userId, userId)];
  if (options.reason) {
    conditions.push(eq(emailSuppressions.reason, options.reason));
  }
  if (options.q?.trim()) {
    conditions.push(ilike(emailSuppressions.email, `%${options.q.trim()}%`));
  }

  const whereClause = and(...conditions);
  const offset = (options.page - 1) * options.limit;

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(emailSuppressions)
      .where(whereClause)
      .orderBy(desc(emailSuppressions.createdAt))
      .limit(options.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailSuppressions)
      .where(whereClause),
  ]);

  const total = countRow[0]?.count ?? 0;

  return {
    suppressions: rows.map(serializeSuppression),
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    },
  };
}

export async function createSuppression(
  db: Database,
  userId: string,
  input: { email: string; reason: SuppressionReason },
) {
  const email = normalizeEmail(input.email);

  try {
    const [row] = await db
      .insert(emailSuppressions)
      .values({
        id: crypto.randomUUID(),
        userId,
        email,
        reason: input.reason,
      })
      .onConflictDoUpdate({
        target: [emailSuppressions.userId, emailSuppressions.email],
        set: {
          reason: input.reason,
          updatedAt: new Date(),
        },
      })
      .returning();

    await db
      .update(contacts)
      .set({ subscriptionStatus: "unsubscribed", updatedAt: new Date() })
      .where(and(eq(contacts.userId, userId), eq(contacts.email, email)));

    return row ?? null;
  } catch (error) {
    const pgCode = (error as { code?: string }).code;
    if (pgCode === "23505") {
      throw new Error("DUPLICATE", { cause: error });
    }
    throw error;
  }
}
