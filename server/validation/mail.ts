import { z } from "zod";

export const mailPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000),
  limit: z.coerce.number().int().min(1).max(50),
});

export const mailboxFolderSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => !value.includes("\u0000") && !value.includes("\n") && !value.includes("\r"),
    "Invalid folder",
  );

export const mailUidSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number(value) <= Number.MAX_SAFE_INTEGER, "Invalid message");

export const individualSendSchema = z.object({
  senderEmail: z.string().trim().max(320),
  to: z.array(z.string().trim().min(1).max(320)).min(1).max(3),
  cc: z.array(z.string().trim().min(1).max(320)).max(3).default([]),
  bcc: z.array(z.string().trim().min(1).max(320)).max(3).default([]),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks"),
  contentJson: z.unknown(),
  draftId: z.string().trim().min(1).max(80).nullable().optional(),
  idempotencyKey: z.string().uuid(),
  confirm: z.literal(true),
});

export const individualSendListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const testSendSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks"),
  text: z.string().trim().min(1).max(20_000),
  html: z.string().max(100_000).optional(),
  confirm: z.literal(true),
  idempotencyKey: z.string().uuid(),
});
