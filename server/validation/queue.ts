import { z } from "zod";

import { DELIVERY_JOB_STATUSES } from "../queue/configuration.js";

export const listQueueJobsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(DELIVERY_JOB_STATUSES).optional(),
  q: z.string().max(120).optional(),
  campaignId: z.string().uuid().optional(),
});

export const deliveryJobIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const listQueueEventsQuerySchema = z.object({
  campaignId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
