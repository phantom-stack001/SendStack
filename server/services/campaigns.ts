import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";

import type { Database } from "../db/index.js";
import {
  campaignEvents,
  campaignRecipientSources,
  campaignRecipients,
  campaigns,
  contactListMembers,
  contactLists,
  contacts,
  emailSuppressions,
} from "../db/schema.js";
import { recordCampaignEvent, serializeCampaignEvent } from "./campaign-audit.js";
import {
  snapshotDraftIntoCampaign,
  validateCampaignContentFields,
} from "./campaign-content.js";
import {
  buildEligibilitySnapshot,
  type ContactCandidate,
  type EligibilityRow,
  type EligibilitySummary,
} from "./campaign-eligibility.js";
import { getContactListById } from "./contact-lists.js";
import type { CampaignStatus } from "../validation/campaigns.js";
import {
  CAMPAIGN_CANCELLABLE_STATUSES,
  CAMPAIGN_PHASE6_EDITABLE_STATUSES,
} from "../validation/campaigns.js";

export type CampaignRow = typeof campaigns.$inferSelect;

export function serializeCampaign(row: CampaignRow, extras?: { recipientSourceCount?: number }) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as CampaignStatus,
    sourceDraftId: row.sourceDraftId,
    senderName: row.senderName,
    senderEmail: row.senderEmail,
    subject: row.subject,
    contentJson: row.contentJson,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    contentRevision: row.contentRevision,
    revision: row.revision,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    scheduleTimezone: row.scheduleTimezone,
    eligibleRecipientCount: row.eligibleRecipientCount,
    queuePaused: row.queuePaused,
    queueGeneration: row.queueGeneration,
    enqueuedAt: row.enqueuedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    recipientSourceCount: extras?.recipientSourceCount,
  };
}

export function serializeRecipientSource(row: typeof campaignRecipientSources.$inferSelect) {
  return {
    id: row.id,
    sourceType: row.sourceType as "individual_contact" | "contact_list",
    contactId: row.contactId,
    contactListId: row.contactListId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getCampaignById(db: Database, userId: string, campaignId: string) {
  const [row] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createCampaign(
  db: Database,
  userId: string,
  input: { name?: string; description?: string },
) {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(campaigns)
    .values({
      id,
      userId,
      name: input.name?.trim() ?? "",
      description: input.description?.trim() ?? "",
      status: "draft",
    })
    .returning();

  if (!row) throw new Error("CREATE_FAILED");

  await recordCampaignEvent(db, {
    campaignId: id,
    actorUserId: userId,
    eventType: "campaign_created",
  });

  return row;
}

export async function getCampaignStats(db: Database, userId: string) {
  const rows = await db
    .select({
      status: campaigns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(campaigns)
    .where(eq(campaigns.userId, userId))
    .groupBy(campaigns.status);

  const stats = {
    total: 0,
    draft: 0,
    ready: 0,
    scheduled: 0,
    cancelled: 0,
  };

  for (const row of rows) {
    stats.total += row.count;
    if (row.status === "draft") stats.draft = row.count;
    if (row.status === "ready") stats.ready = row.count;
    if (row.status === "scheduled") stats.scheduled = row.count;
    if (row.status === "cancelled") stats.cancelled = row.count;
  }

  return stats;
}

export async function listCampaigns(
  db: Database,
  userId: string,
  options: { page: number; limit: number; q?: string; status?: CampaignStatus },
) {
  const conditions = [eq(campaigns.userId, userId)];
  if (options.status) {
    conditions.push(eq(campaigns.status, options.status));
  }
  if (options.q?.trim()) {
    conditions.push(ilike(campaigns.name, `%${options.q.trim()}%`));
  }

  const whereClause = and(...conditions);
  const offset = (options.page - 1) * options.limit;

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(campaigns)
      .where(whereClause)
      .orderBy(desc(campaigns.updatedAt))
      .limit(options.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(campaigns)
      .where(whereClause),
  ]);

  const total = countRow[0]?.count ?? 0;

  return {
    campaigns: rows.map((row) => serializeCampaign(row)),
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    },
  };
}

async function assertEditable(campaign: CampaignRow) {
  if (!CAMPAIGN_PHASE6_EDITABLE_STATUSES.includes(campaign.status as CampaignStatus)) {
    throw new Error("NOT_EDITABLE");
  }
}

async function replaceRecipientSources(
  db: Database,
  campaignId: string,
  contactIds: string[],
  contactListIds: string[],
) {
  await db.delete(campaignRecipientSources).where(eq(campaignRecipientSources.campaignId, campaignId));

  if (contactIds.length > 0) {
    await db.insert(campaignRecipientSources).values(
      contactIds.map((contactId) => ({
        id: crypto.randomUUID(),
        campaignId,
        sourceType: "individual_contact",
        contactId,
        contactListId: null,
      })),
    );
  }

  if (contactListIds.length > 0) {
    await db.insert(campaignRecipientSources).values(
      contactListIds.map((contactListId) => ({
        id: crypto.randomUUID(),
        campaignId,
        sourceType: "contact_list",
        contactId: null,
        contactListId,
      })),
    );
  }
}

async function validateRecipientOwnership(
  db: Database,
  userId: string,
  contactIds: string[],
  contactListIds: string[],
) {
  if (contactIds.length > 0) {
    const owned = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)));
    if (owned.length !== contactIds.length) {
      throw new Error("INVALID_CONTACT_SOURCES");
    }
  }

  if (contactListIds.length > 0) {
    const owned = await db
      .select({ id: contactLists.id })
      .from(contactLists)
      .where(and(eq(contactLists.userId, userId), inArray(contactLists.id, contactListIds)));
    if (owned.length !== contactListIds.length) {
      throw new Error("INVALID_LIST_SOURCES");
    }
  }
}

export async function getRecipientSources(db: Database, campaignId: string) {
  return db
    .select()
    .from(campaignRecipientSources)
    .where(eq(campaignRecipientSources.campaignId, campaignId));
}

export async function collectContactCandidates(
  db: Database,
  userId: string,
  sources: typeof campaignRecipientSources.$inferSelect[],
): Promise<ContactCandidate[]> {
  const individualIds = sources
    .filter((s) => s.sourceType === "individual_contact" && s.contactId)
    .map((s) => s.contactId as string);
  const listIds = sources
    .filter((s) => s.sourceType === "contact_list" && s.contactListId)
    .map((s) => s.contactListId as string);

  const candidates: ContactCandidate[] = [];

  if (individualIds.length > 0) {
    const rows = await db
      .select({
        id: contacts.id,
        email: contacts.email,
        subscriptionStatus: contacts.subscriptionStatus,
      })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, individualIds)));
    for (const row of rows) {
      candidates.push({
        contactId: row.id,
        email: row.email,
        subscriptionStatus: row.subscriptionStatus as ContactCandidate["subscriptionStatus"],
      });
    }
  }

  if (listIds.length > 0) {
    const rows = await db
      .select({
        id: contacts.id,
        email: contacts.email,
        subscriptionStatus: contacts.subscriptionStatus,
      })
      .from(contactListMembers)
      .innerJoin(contacts, eq(contactListMembers.contactId, contacts.id))
      .innerJoin(contactLists, eq(contactListMembers.listId, contactLists.id))
      .where(and(eq(contactLists.userId, userId), inArray(contactLists.id, listIds)));

    for (const row of rows) {
      candidates.push({
        contactId: row.id,
        email: row.email,
        subscriptionStatus: row.subscriptionStatus as ContactCandidate["subscriptionStatus"],
      });
    }
  }

  return candidates;
}

async function loadSuppressedSet(db: Database, userId: string) {
  const rows = await db
    .select({ email: emailSuppressions.email })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.userId, userId));
  return new Set(rows.map((r) => r.email));
}

export async function computeEligibilityForCampaign(
  db: Database,
  userId: string,
  campaignId: string,
): Promise<{ rows: ReturnType<typeof buildEligibilitySnapshot>["rows"]; summary: EligibilitySummary }> {
  const sources = await getRecipientSources(db, campaignId);
  return computeEligibilityFromSources(db, userId, sources);
}

function sourcesFromRecipientIds(contactIds: string[], contactListIds: string[]) {
  const uniqueContactIds = [...new Set(contactIds)];
  const uniqueListIds = [...new Set(contactListIds)];
  const sources: typeof campaignRecipientSources.$inferSelect[] = [
    ...uniqueContactIds.map((contactId) => ({
      id: "",
      campaignId: "",
      sourceType: "individual_contact",
      contactId,
      contactListId: null,
      createdAt: new Date(),
    })),
    ...uniqueListIds.map((contactListId) => ({
      id: "",
      campaignId: "",
      sourceType: "contact_list",
      contactId: null,
      contactListId,
      createdAt: new Date(),
    })),
  ];
  return { uniqueContactIds, uniqueListIds, sources };
}

export async function computeEligibilityFromSources(
  db: Database,
  userId: string,
  sources: typeof campaignRecipientSources.$inferSelect[],
): Promise<{ rows: EligibilityRow[]; summary: EligibilitySummary }> {
  const candidates = await collectContactCandidates(db, userId, sources);
  const suppressed = await loadSuppressedSet(db, userId);
  return buildEligibilitySnapshot(candidates, suppressed);
}

export async function computeEligibilityForRecipientSources(
  db: Database,
  userId: string,
  contactIds: string[],
  contactListIds: string[],
): Promise<{ rows: EligibilityRow[]; summary: EligibilitySummary }> {
  const { uniqueContactIds, uniqueListIds, sources } = sourcesFromRecipientIds(
    contactIds,
    contactListIds,
  );
  await validateRecipientOwnership(db, userId, uniqueContactIds, uniqueListIds);
  return computeEligibilityFromSources(db, userId, sources);
}

export type RecipientEligibilityExclusion = {
  contactId: string | null;
  email: string;
  eligibilityStatus: EligibilityRow["eligibilityStatus"];
  eligibilityReason: string;
};

export type ContactListEligibilityHint = {
  listId: string;
  name: string;
  memberCount: number;
  eligible: number;
  excluded: number;
};

const EXCLUSION_PREVIEW_LIMIT = 100;

export async function previewRecipientEligibility(
  db: Database,
  userId: string,
  contactIds: string[],
  contactListIds: string[],
): Promise<{
  summary: EligibilitySummary;
  exclusions: RecipientEligibilityExclusion[];
  listHints: ContactListEligibilityHint[];
}> {
  const { uniqueListIds } = sourcesFromRecipientIds(contactIds, contactListIds);
  const { rows, summary } = await computeEligibilityForRecipientSources(
    db,
    userId,
    contactIds,
    contactListIds,
  );

  const exclusions = rows
    .filter((row) => row.eligibilityStatus !== "eligible")
    .slice(0, EXCLUSION_PREVIEW_LIMIT)
    .map((row) => ({
      contactId: row.contactId,
      email: row.email,
      eligibilityStatus: row.eligibilityStatus,
      eligibilityReason: row.eligibilityReason,
    }));

  const listHints: ContactListEligibilityHint[] = [];
  for (const listId of uniqueListIds) {
    const list = await getContactListById(db, userId, listId);
    if (!list) continue;
    const { summary: listSummary } = await computeEligibilityForRecipientSources(
      db,
      userId,
      [],
      [listId],
    );
    listHints.push({
      listId,
      name: list.name,
      memberCount: listSummary.selectedRaw,
      eligible: listSummary.eligible,
      excluded: listSummary.excludedTotal,
    });
  }

  return { summary, exclusions, listHints };
}

/** Recalculate eligibility snapshot without changing campaign lifecycle status. */
export async function refreshCampaignRecipientSnapshot(
  db: Database,
  userId: string,
  campaignId: string,
) {
  const existing = await getCampaignById(db, userId, campaignId);
  if (!existing) return null;

  const { rows, summary } = await computeEligibilityForCampaign(db, userId, campaignId);
  const evaluatedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.delete(campaignRecipients).where(eq(campaignRecipients.campaignId, campaignId));
    if (rows.length > 0) {
      await tx.insert(campaignRecipients).values(
        rows.map((row) => ({
          id: crypto.randomUUID(),
          campaignId,
          contactId: row.contactId,
          email: row.email,
          eligibilityStatus: row.eligibilityStatus,
          eligibilityReason: row.eligibilityReason,
          evaluatedAt,
        })),
      );
    }

    await tx
      .update(campaigns)
      .set({
        eligibleRecipientCount: summary.eligible,
        revision: existing.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)));

    await recordCampaignEvent(tx, {
      campaignId,
      actorUserId: userId,
      eventType: "eligibility_checked",
      metadata: { summary, context: "pre_enqueue" },
    });
  });

  return summary;
}

export async function updateCampaign(
  db: Database,
  userId: string,
  campaignId: string,
  input: {
    expectedRevision: number;
    name?: string;
    description?: string;
    sourceDraftId?: string | null;
    recipientSources?: { contactIds?: string[]; contactListIds?: string[] };
    scheduledAt?: string | null;
    scheduleTimezone?: string | null;
    revertToDraft?: boolean;
  },
) {
  const existing = await getCampaignById(db, userId, campaignId);
  if (!existing) return null;

  if (existing.revision !== input.expectedRevision) {
    throw new Error("REVISION_CONFLICT");
  }

  if (input.revertToDraft) {
    if (!["ready", "scheduled"].includes(existing.status)) {
      throw new Error("INVALID_TRANSITION");
    }
    const [row] = await db
      .update(campaigns)
      .set({
        status: "draft",
        revision: existing.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
      .returning();
    await recordCampaignEvent(db, {
      campaignId,
      actorUserId: userId,
      eventType: "campaign_reverted_to_draft",
    });
    return row ?? null;
  }

  await assertEditable(existing);

  const patch: Partial<typeof campaigns.$inferInsert> = {
    revision: existing.revision + 1,
    updatedAt: new Date(),
  };

  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description.trim();

  if (input.sourceDraftId !== undefined) {
    if (input.sourceDraftId === null) {
      patch.sourceDraftId = null;
    } else {
      const snapshot = await snapshotDraftIntoCampaign(db, userId, input.sourceDraftId);
      Object.assign(patch, {
        ...snapshot,
        contentRevision: (existing.contentRevision ?? 0) + 1,
      });
      await recordCampaignEvent(db, {
        campaignId,
        actorUserId: userId,
        eventType: "content_selected",
        metadata: { sourceDraftId: input.sourceDraftId },
      });
    }
  }

  if (input.recipientSources) {
    const contactIds = [...new Set(input.recipientSources.contactIds ?? [])];
    const contactListIds = [...new Set(input.recipientSources.contactListIds ?? [])];
    await validateRecipientOwnership(db, userId, contactIds, contactListIds);
    await replaceRecipientSources(db, campaignId, contactIds, contactListIds);
    await recordCampaignEvent(db, {
      campaignId,
      actorUserId: userId,
      eventType: "recipients_updated",
      metadata: {
        contactCount: contactIds.length,
        listCount: contactListIds.length,
      },
    });
  }

  if (input.scheduledAt !== undefined) {
    patch.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    patch.scheduleTimezone = input.scheduleTimezone ?? null;
    if (input.scheduledAt) {
      await recordCampaignEvent(db, {
        campaignId,
        actorUserId: userId,
        eventType: "schedule_configured",
        metadata: {
          scheduledAt: input.scheduledAt,
          scheduleTimezone: input.scheduleTimezone,
        },
      });
    }
  } else if (input.scheduleTimezone !== undefined) {
    patch.scheduleTimezone = input.scheduleTimezone;
  }

  const [row] = await db
    .update(campaigns)
    .set(patch)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .returning();

  if (row) {
    await recordCampaignEvent(db, {
      campaignId,
      actorUserId: userId,
      eventType: "campaign_updated",
    });
  }

  return row ?? null;
}

export async function deleteCampaign(db: Database, userId: string, campaignId: string) {
  const existing = await getCampaignById(db, userId, campaignId);
  if (!existing) return null;
  if (existing.status !== "draft") {
    throw new Error("NOT_DELETABLE");
  }

  const [row] = await db
    .delete(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .returning({ id: campaigns.id });

  return row ?? null;
}

export async function duplicateCampaign(db: Database, userId: string, campaignId: string) {
  const existing = await getCampaignById(db, userId, campaignId);
  if (!existing) return null;

  const sources = await getRecipientSources(db, campaignId);
  const newId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    const [copy] = await tx
      .insert(campaigns)
      .values({
        id: newId,
        userId,
        name: existing.name ? `${existing.name} (copy)` : "Untitled campaign (copy)",
        description: existing.description,
        status: "draft",
        sourceDraftId: existing.sourceDraftId,
        senderName: existing.senderName,
        senderEmail: existing.senderEmail,
        subject: existing.subject,
        contentJson: existing.contentJson,
        bodyHtml: existing.bodyHtml,
        bodyText: existing.bodyText,
        contentRevision: existing.contentRevision,
        scheduledAt: null,
        scheduleTimezone: null,
        eligibleRecipientCount: 0,
      })
      .returning();

    if (!copy) throw new Error("DUPLICATE_FAILED");

    if (sources.length > 0) {
      await tx.insert(campaignRecipientSources).values(
        sources.map((s) => ({
          id: crypto.randomUUID(),
          campaignId: newId,
          sourceType: s.sourceType,
          contactId: s.contactId,
          contactListId: s.contactListId,
        })),
      );
    }

    await recordCampaignEvent(tx, {
      campaignId: newId,
      actorUserId: userId,
      eventType: "campaign_duplicated",
      metadata: { sourceCampaignId: campaignId },
    });

    return copy;
  });
}

export async function cancelCampaign(db: Database, userId: string, campaignId: string) {
  const existing = await getCampaignById(db, userId, campaignId);
  if (!existing) return null;
  if (!CAMPAIGN_CANCELLABLE_STATUSES.includes(existing.status as CampaignStatus)) {
    throw new Error("NOT_CANCELLABLE");
  }

  const [row] = await db
    .update(campaigns)
    .set({
      status: "cancelled",
      revision: existing.revision + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .returning();

  if (row) {
    await recordCampaignEvent(db, {
      campaignId,
      actorUserId: userId,
      eventType: "campaign_cancelled",
    });
  }

  return row ?? null;
}

function validateSchedule(scheduledAt: Date, scheduleTimezone: string | null) {
  if (scheduledAt.getTime() <= Date.now()) {
    throw new Error("SCHEDULE_MUST_BE_FUTURE");
  }
  if (!scheduleTimezone?.trim()) {
    throw new Error("SCHEDULE_TIMEZONE_REQUIRED");
  }
}

export async function prepareCampaign(
  db: Database,
  userId: string,
  campaignId: string,
  options: { markReady: boolean },
) {
  const existing = await getCampaignById(db, userId, campaignId);
  if (!existing) return null;

  if (!CAMPAIGN_PHASE6_EDITABLE_STATUSES.includes(existing.status as CampaignStatus)) {
    throw new Error("NOT_EDITABLE");
  }

  const contentIssues = validateCampaignContentFields({
    senderName: existing.senderName,
    senderEmail: existing.senderEmail,
    subject: existing.subject,
    bodyHtml: existing.bodyHtml,
    bodyText: existing.bodyText,
  });

  if (options.markReady && contentIssues.length > 0) {
    return { campaign: existing, contentIssues, eligibility: null as EligibilitySummary | null };
  }

  const { rows, summary } = await computeEligibilityForCampaign(db, userId, campaignId);

  if (options.markReady) {
    if (!existing.name.trim()) {
      throw new Error("NAME_REQUIRED");
    }
    if (summary.eligible === 0) {
      const err = new Error("NO_ELIGIBLE_RECIPIENTS") as Error & {
        eligibilitySummary?: EligibilitySummary;
      };
      err.eligibilitySummary = summary;
      throw err;
    }
    if (existing.scheduledAt) {
      validateSchedule(existing.scheduledAt, existing.scheduleTimezone);
    }
  }

  const evaluatedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.delete(campaignRecipients).where(eq(campaignRecipients.campaignId, campaignId));

    if (rows.length > 0) {
      await tx.insert(campaignRecipients).values(
        rows.map((row) => ({
          id: crypto.randomUUID(),
          campaignId,
          contactId: row.contactId,
          email: row.email,
          eligibilityStatus: row.eligibilityStatus,
          eligibilityReason: row.eligibilityReason,
          evaluatedAt,
        })),
      );
    }

    const nextStatus: CampaignStatus = options.markReady
      ? existing.scheduledAt
        ? "scheduled"
        : "ready"
      : (existing.status as CampaignStatus);

    await tx
      .update(campaigns)
      .set({
        eligibleRecipientCount: summary.eligible,
        revision: existing.revision + 1,
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)));

    await recordCampaignEvent(tx, {
      campaignId,
      actorUserId: userId,
      eventType: "eligibility_checked",
      metadata: { summary },
    });

    if (options.markReady) {
      await recordCampaignEvent(tx, {
        campaignId,
        actorUserId: userId,
        eventType: "campaign_marked_ready",
        metadata: { eligible: summary.eligible },
      });
    } else {
      await recordCampaignEvent(tx, {
        campaignId,
        actorUserId: userId,
        eventType: "campaign_prepared",
        metadata: { eligible: summary.eligible },
      });
    }
  });

  const updated = await getCampaignById(db, userId, campaignId);
  return {
    campaign: updated,
    contentIssues,
    eligibility: summary,
  };
}

export async function validateCampaign(
  db: Database,
  userId: string,
  campaignId: string,
) {
  const existing = await getCampaignById(db, userId, campaignId);
  if (!existing) return null;

  const contentIssues = validateCampaignContentFields({
    senderName: existing.senderName,
    senderEmail: existing.senderEmail,
    subject: existing.subject,
    bodyHtml: existing.bodyHtml,
    bodyText: existing.bodyText,
  });

  const { rows, summary } = await computeEligibilityForCampaign(db, userId, campaignId);

  const exclusions = rows
    .filter((row) => row.eligibilityStatus !== "eligible")
    .slice(0, EXCLUSION_PREVIEW_LIMIT)
    .map((row) => ({
      contactId: row.contactId,
      email: row.email,
      eligibilityStatus: row.eligibilityStatus,
      eligibilityReason: row.eligibilityReason,
    }));

  const recipientIssues: { code: string; message: string }[] = [];
  if (summary.selectedRaw === 0) {
    recipientIssues.push({
      code: "NO_RECIPIENT_SOURCES",
      message: "Select at least one contact or contact list.",
    });
  } else if (summary.eligible === 0) {
    recipientIssues.push({
      code: "NO_ELIGIBLE_RECIPIENTS",
      message: "No eligible recipients are currently selected.",
    });
  }

  return {
    contentIssues,
    eligibility: summary,
    exclusions,
    recipientIssues,
    canMarkReady:
      contentIssues.length === 0 &&
      recipientIssues.length === 0 &&
      existing.name.trim().length > 0 &&
      summary.eligible > 0,
  };
}

export async function getCampaignDetail(db: Database, userId: string, campaignId: string) {
  const campaign = await getCampaignById(db, userId, campaignId);
  if (!campaign) return null;

  const [sources, events, recipientRows] = await Promise.all([
    getRecipientSources(db, campaignId),
    db
      .select()
      .from(campaignEvents)
      .where(eq(campaignEvents.campaignId, campaignId))
      .orderBy(desc(campaignEvents.createdAt))
      .limit(50),
    db
      .select({
        eligibilityStatus: campaignRecipients.eligibilityStatus,
        count: sql<number>`count(*)::int`,
      })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId))
      .groupBy(campaignRecipients.eligibilityStatus),
  ]);

  const snapshotSummary: Partial<EligibilitySummary> = {};
  for (const row of recipientRows) {
    if (row.eligibilityStatus === "eligible") snapshotSummary.eligible = row.count;
  }

  return {
    campaign: serializeCampaign(campaign),
    recipientSources: sources.map(serializeRecipientSource),
    events: events.map(serializeCampaignEvent),
    snapshotEligibleCount: snapshotSummary.eligible ?? campaign.eligibleRecipientCount,
  };
}

export async function listCampaignEvents(db: Database, userId: string, campaignId: string) {
  const campaign = await getCampaignById(db, userId, campaignId);
  if (!campaign) return null;

  const events = await db
    .select()
    .from(campaignEvents)
    .where(eq(campaignEvents.campaignId, campaignId))
    .orderBy(desc(campaignEvents.createdAt))
    .limit(100);

  return events.map(serializeCampaignEvent);
}
