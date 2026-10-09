import { z } from "zod";

export const QUEUE_NAMES = {
  campaignDispatch: "sendstack-campaign-dispatch",
  emailProcessing: "sendstack-email-processing",
} as const;

export const DELIVERY_JOB_STATUSES = [
  "pending",
  "queued",
  "processing",
  "retry_wait",
  "simulation_completed",
  "simulation_failed",
  "skipped",
  "cancelled",
] as const;

export type DeliveryJobStatus = (typeof DELIVERY_JOB_STATUSES)[number];

export const queueEnvSchema = z
  .object({
    QUEUE_ENABLED: z.coerce.boolean().default(false),
    QUEUE_SIMULATION_ONLY: z
      .preprocess((value) => {
        if (value === undefined || value === "") return true;
        if (value === false || value === "false" || value === "0") return false;
        return true;
      }, z.literal(true))
      .default(true),
    REDIS_URL: z.string().optional(),
    QUEUE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
    QUEUE_MAX_JOBS_PER_SECOND: z.coerce.number().int().min(1).max(1000).default(5),
    QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    QUEUE_JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    QUEUE_SIMULATION_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(25),
    QUEUE_NAMESPACE: z.string().max(40).default("sendstack"),
  })
  .superRefine((data, ctx) => {
    if (!data.QUEUE_SIMULATION_ONLY) {
      ctx.addIssue({
        code: "custom",
        message: "QUEUE_SIMULATION_ONLY must remain true in Phase 7",
        path: ["QUEUE_SIMULATION_ONLY"],
      });
    }
    if (data.QUEUE_ENABLED && !data.REDIS_URL?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "REDIS_URL is required when QUEUE_ENABLED=true",
        path: ["REDIS_URL"],
      });
    }
  });

export type QueueEnv = z.infer<typeof queueEnvSchema>;

export function loadQueueEnv(): QueueEnv {
  const parsed = queueEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid queue environment: ${message}`);
  }
  return parsed.data;
}

export function bullmqJobRetentionMs(days: number) {
  return days * 24 * 60 * 60 * 1000;
}
