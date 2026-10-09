import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import type { Database } from "../db/index.js";
import {
  contactConsentEvents,
  contactListMembers,
  contactLists,
  contacts,
  emailSuppressions,
} from "../db/schema.js";
import { isValidEmail, normalizeEmail } from "../lib/email-normalization.js";
import type { SubscriptionStatus } from "../validation/contacts.js";

export type ContactRow = typeof contacts.$inferSelect;

export function serializeContact(
  row: ContactRow,
  extras?: { listNames?: string[] },
) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    company: row.company,
    phone: row.phone,
    subscriptionStatus: row.subscriptionStatus as SubscriptionStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    listNames: extras?.listNames ?? [],
  };
}

async function recordConsentEvent(
  db: Database,
  input: {
    userId: string;
    contactId: string;
    eventType: "consent_granted" | "consent_withdrawn" | "consent_updated";
    source: string;
    occurredAt: Date;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(contactConsentEvents).values({
    id: crypto.randomUUID(),
    userId: input.userId,
    contactId: input.contactId,
    eventType: input.eventType,
    source: input.source,
    occurredAt: input.occurredAt,
    metadata: input.metadata,
  });
}

async function isEmailSuppressed(db: Database, userId: string, email: string) {
  const [row] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(and(eq(emailSuppressions.userId, userId), eq(emailSuppressions.email, email)))
    .limit(1);
  return Boolean(row);
}

export async function getContactStats(db: Database, userId: string) {
  const rows = await db
    .select({
      status: contacts.subscriptionStatus,
      count: sql<number>`count(*)::int`,
    })
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .groupBy(contacts.subscriptionStatus);

  const stats = {
    total: 0,
    subscribed: 0,
    unsubscribed: 0,
    pending: 0,
    unknown: 0,
  };

  for (const row of rows) {
    stats.total += row.count;
    if (row.status === "subscribed") stats.subscribed = row.count;
    if (row.status === "unsubscribed") stats.unsubscribed = row.count;
    if (row.status === "pending") stats.pending = row.count;
    if (row.status === "unknown") stats.unknown = row.count;
  }

  return stats;
}

export async function listContacts(
  db: Database,
  userId: string,
  options: {
    page: number;
    limit: number;
    q?: string;
    status?: SubscriptionStatus;
    listId?: string;
    sort: "created_at_desc" | "created_at_asc" | "email_asc";
  },
) {
  const offset = (options.page - 1) * options.limit;
  const conditions = [eq(contacts.userId, userId)];

  if (options.status) {
    conditions.push(eq(contacts.subscriptionStatus, options.status));
  }

  if (options.q?.trim()) {
    const term = `%${options.q.trim()}%`;
    conditions.push(
      or(
        ilike(contacts.email, term),
        ilike(contacts.firstName, term),
        ilike(contacts.lastName, term),
        ilike(contacts.company, term),
      )!,
    );
  }

  const whereClause = and(...conditions);

  if (options.listId) {
    const members = await db
      .select({ contactId: contactListMembers.contactId })
      .from(contactListMembers)
      .innerJoin(contactLists, eq(contactLists.id, contactListMembers.listId))
      .where(
        and(eq(contactListMembers.listId, options.listId), eq(contactLists.userId, userId)),
      );
    const memberIds = members.map((row) => row.contactId);
    if (memberIds.length === 0) {
      return {
        contacts: [],
        pagination: {
          page: options.page,
          limit: options.limit,
          total: 0,
          totalPages: 1,
        },
      };
    }
    conditions.push(inArray(contacts.id, memberIds));
  }

  const orderBy =
    options.sort === "email_asc"
      ? asc(contacts.email)
      : options.sort === "created_at_asc"
        ? asc(contacts.createdAt)
        : desc(contacts.createdAt);

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(contacts)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(options.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(whereClause),
  ]);

  const contactIds = rows.map((row) => row.id);
  const listNameMap = new Map<string, string[]>();

  if (contactIds.length > 0) {
    const memberships = await db
      .select({
        contactId: contactListMembers.contactId,
        listName: contactLists.name,
      })
      .from(contactListMembers)
      .innerJoin(contactLists, eq(contactLists.id, contactListMembers.listId))
      .where(
        and(
          eq(contactLists.userId, userId),
          inArray(contactListMembers.contactId, contactIds),
        ),
      );

    for (const membership of memberships) {
      const current = listNameMap.get(membership.contactId) ?? [];
      current.push(membership.listName);
      listNameMap.set(membership.contactId, current);
    }
  }

  const total = countRow[0]?.count ?? 0;

  return {
    contacts: rows.map((row) =>
      serializeContact(row, { listNames: listNameMap.get(row.id) ?? [] }),
    ),
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    },
  };
}

export async function getContactById(db: Database, userId: string, contactId: string) {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createContact(
  db: Database,
  userId: string,
  input: {
    email: string;
    firstName?: string;
    lastName?: string;
    company?: string;
    phone?: string;
    subscriptionStatus?: SubscriptionStatus;
    consentSource?: string;
    consentMethod?: string;
    consentOccurredAt?: string;
  },
) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    throw new Error("INVALID_EMAIL");
  }

  const suppressed = await isEmailSuppressed(db, userId, email);
  let status: SubscriptionStatus = input.subscriptionStatus ?? "unknown";
  if (suppressed) {
    status = "unsubscribed";
  } else if (status === "subscribed" && !input.consentSource) {
    throw new Error("CONSENT_REQUIRED");
  }

  const id = crypto.randomUUID();
  try {
    const [row] = await db
      .insert(contacts)
      .values({
        id,
        userId,
        email,
        firstName: input.firstName?.trim() ?? "",
        lastName: input.lastName?.trim() ?? "",
        company: input.company?.trim() ?? "",
        phone: input.phone?.trim() ?? "",
        subscriptionStatus: status,
      })
      .returning();

    if (!row) throw new Error("CREATE_FAILED");

    if (status === "subscribed" && input.consentSource && input.consentOccurredAt) {
      await recordConsentEvent(db, {
        userId,
        contactId: row.id,
        eventType: "consent_granted",
        source: input.consentSource,
        occurredAt: new Date(input.consentOccurredAt),
        metadata: input.consentMethod ? { method: input.consentMethod } : undefined,
      });
    }

    return row;
  } catch (error) {
    if (error instanceof Error && error.message.includes("unique")) {
      throw new Error("DUPLICATE_EMAIL", { cause: error });
    }
    const pgCode = (error as { code?: string }).code;
    if (pgCode === "23505") {
      throw new Error("DUPLICATE_EMAIL", { cause: error });
    }
    throw error;
  }
}

export async function updateContact(
  db: Database,
  userId: string,
  contactId: string,
  input: {
    email?: string;
    firstName?: string;
    lastName?: string;
    company?: string;
    phone?: string;
    subscriptionStatus?: SubscriptionStatus;
    consentSource?: string;
    consentMethod?: string;
    consentOccurredAt?: string;
  },
) {
  const existing = await getContactById(db, userId, contactId);
  if (!existing) return null;

  const nextEmail = input.email ? normalizeEmail(input.email) : existing.email;
  if (!isValidEmail(nextEmail)) {
    throw new Error("INVALID_EMAIL");
  }

  const emailChanged = nextEmail !== existing.email;
  let nextStatus = input.subscriptionStatus ?? existing.subscriptionStatus;

  const suppressed = await isEmailSuppressed(db, userId, nextEmail);
  if (suppressed) {
    nextStatus = "unsubscribed";
  } else if (nextStatus === "subscribed") {
    if (emailChanged || existing.subscriptionStatus !== "subscribed") {
      if (!input.consentSource || !input.consentOccurredAt) {
        throw new Error("CONSENT_REQUIRED");
      }
    }
  }

  try {
    const [row] = await db
      .update(contacts)
      .set({
        email: nextEmail,
        firstName: input.firstName?.trim() ?? existing.firstName,
        lastName: input.lastName?.trim() ?? existing.lastName,
        company: input.company?.trim() ?? existing.company,
        phone: input.phone?.trim() ?? existing.phone,
        subscriptionStatus: nextStatus,
        updatedAt: new Date(),
      })
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
      .returning();

    if (!row) return null;

    if (
      nextStatus === "subscribed" &&
      input.consentSource &&
      input.consentOccurredAt &&
      (emailChanged || existing.subscriptionStatus !== "subscribed")
    ) {
      await recordConsentEvent(db, {
        userId,
        contactId: row.id,
        eventType: emailChanged ? "consent_updated" : "consent_granted",
        source: input.consentSource,
        occurredAt: new Date(input.consentOccurredAt),
        metadata: input.consentMethod ? { method: input.consentMethod } : undefined,
      });
    }

    return row;
  } catch (error) {
    const pgCode = (error as { code?: string }).code;
    if (pgCode === "23505") {
      throw new Error("DUPLICATE_EMAIL", { cause: error });
    }
    throw error;
  }
}

export async function deleteContact(db: Database, userId: string, contactId: string) {
  const [row] = await db
    .delete(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .returning({ id: contacts.id });
  return row ?? null;
}

export async function unsubscribeContact(db: Database, userId: string, contactId: string) {
  const existing = await getContactById(db, userId, contactId);
  if (!existing) return null;

  const [row] = await db
    .update(contacts)
    .set({
      subscriptionStatus: "unsubscribed",
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .returning();

  if (!row) return null;

  await recordConsentEvent(db, {
    userId,
    contactId: row.id,
    eventType: "consent_withdrawn",
    source: "manual_unsubscribe",
    occurredAt: new Date(),
  });

  await db
    .insert(emailSuppressions)
    .values({
      id: crypto.randomUUID(),
      userId,
      email: row.email,
      reason: "unsubscribed",
    })
    .onConflictDoUpdate({
      target: [emailSuppressions.userId, emailSuppressions.email],
      set: { reason: "unsubscribed", updatedAt: new Date() },
    });

  return row;
}

export async function bulkUnsubscribeContacts(
  db: Database,
  userId: string,
  contactIds: string[],
) {
  const owned = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)));

  const ids = owned.map((row) => row.id);
  for (const id of ids) {
    await unsubscribeContact(db, userId, id);
  }
  return { updated: ids.length };
}

export async function bulkDeleteContacts(
  db: Database,
  userId: string,
  contactIds: string[],
) {
  const result = await db
    .delete(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)))
    .returning({ id: contacts.id });
  return { deleted: result.length };
}
