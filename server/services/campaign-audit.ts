import type { Database } from "../db/index.js";
import { campaignEvents } from "../db/schema.js";

type DbInsert = Pick<Database, "insert">;

export type CampaignEventType =
  | "campaign_created"
  | "campaign_updated"
  | "content_selected"
  | "recipients_updated"
  | "eligibility_checked"
  | "campaign_marked_ready"
  | "schedule_configured"
  | "campaign_cancelled"
  | "campaign_duplicated"
  | "campaign_reverted_to_draft"
  | "campaign_prepared";

export async function recordCampaignEvent(
  db: DbInsert,
  input: {
    campaignId: string;
    actorUserId: string;
    eventType: CampaignEventType;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(campaignEvents).values({
    id: crypto.randomUUID(),
    campaignId: input.campaignId,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    metadata: input.metadata,
  });
}

export function serializeCampaignEvent(row: typeof campaignEvents.$inferSelect) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    actorUserId: row.actorUserId,
    eventType: row.eventType,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
