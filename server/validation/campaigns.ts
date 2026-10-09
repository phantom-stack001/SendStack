import { z } from "zod";

export const CAMPAIGN_STATUSES = [
  "draft",
  "ready",
  "scheduled",
  "queued",
  "processing",
  "paused",
  "simulation_completed",
  "simulation_failed",
  "sending",
  "completed",
  "failed",
  "cancelled",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_PHASE6_EDITABLE_STATUSES: CampaignStatus[] = ["draft"];
export const CAMPAIGN_CANCELLABLE_STATUSES: CampaignStatus[] = [
  "draft",
  "ready",
  "scheduled",
  "queued",
  "processing",
  "paused",
];

export const CAMPAIGN_LIMITS = {
  nameMax: 200,
  descriptionMax: 2000,
  listDefaultLimit: 25,
  listMaxLimit: 100,
  maxIndividualSources: 500,
  maxListSources: 50,
} as const;

export const campaignIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const listCampaignsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CAMPAIGN_LIMITS.listMaxLimit)
    .default(CAMPAIGN_LIMITS.listDefaultLimit),
  q: z.string().max(200).optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

export const createCampaignSchema = z.object({
  name: z.string().max(CAMPAIGN_LIMITS.nameMax).optional(),
  description: z.string().max(CAMPAIGN_LIMITS.descriptionMax).optional(),
});

export const updateCampaignSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    name: z.string().max(CAMPAIGN_LIMITS.nameMax).optional(),
    description: z.string().max(CAMPAIGN_LIMITS.descriptionMax).optional(),
    sourceDraftId: z.string().uuid().nullable().optional(),
    recipientSources: z
      .object({
        contactIds: z.array(z.string().uuid()).max(CAMPAIGN_LIMITS.maxIndividualSources).optional(),
        contactListIds: z.array(z.string().uuid()).max(CAMPAIGN_LIMITS.maxListSources).optional(),
      })
      .optional(),
    scheduledAt: z.string().datetime().nullable().optional(),
    scheduleTimezone: z.string().max(80).nullable().optional(),
    revertToDraft: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scheduledAt && data.scheduleTimezone === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Timezone is required when scheduling",
        path: ["scheduleTimezone"],
      });
    }
  });

export const prepareCampaignSchema = z.object({
  markReady: z.boolean().default(false),
});

export const recipientEligibilityPreviewSchema = z.object({
  contactIds: z.array(z.string().uuid()).max(CAMPAIGN_LIMITS.maxIndividualSources).default([]),
  contactListIds: z.array(z.string().uuid()).max(CAMPAIGN_LIMITS.maxListSources).default([]),
});

export const scheduleInputSchema = z.object({
  scheduledAt: z.string().datetime(),
  scheduleTimezone: z.string().min(1).max(80),
});
