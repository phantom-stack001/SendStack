import { z } from "zod";

import { estimateJsonSize, validateTiptapDocument } from "../lib/email-content.js";

export const DRAFT_LIMITS = {
  senderNameMax: 200,
  senderEmailMax: 320,
  subjectMax: 500,
  contentJsonMaxBytes: 512_000,
  bodyHtmlMaxBytes: 512_000,
  listDefaultLimit: 25,
  listMaxLimit: 100,
} as const;

const optionalEmailSchema = z
  .string()
  .max(DRAFT_LIMITS.senderEmailMax)
  .refine((value) => value === "" || z.email().safeParse(value).success, {
    message: "Invalid sender email address",
  });

export const draftFieldsSchema = z.object({
  senderName: z.string().max(DRAFT_LIMITS.senderNameMax).optional(),
  senderEmail: optionalEmailSchema.optional(),
  subject: z.string().max(DRAFT_LIMITS.subjectMax).optional(),
  contentJson: z.unknown().optional(),
});

export const createDraftSchema = draftFieldsSchema.superRefine((data, ctx) => {
  if (data.contentJson !== undefined) {
    const size = estimateJsonSize(data.contentJson);
    if (size > DRAFT_LIMITS.contentJsonMaxBytes) {
      ctx.addIssue({
        code: "custom",
        message: "Email content is too large",
        path: ["contentJson"],
      });
      return;
    }
    if (!validateTiptapDocument(data.contentJson)) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid editor document",
        path: ["contentJson"],
      });
    }
  }
});

export const updateDraftSchema = createDraftSchema;

export const listDraftsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DRAFT_LIMITS.listMaxLimit)
    .default(DRAFT_LIMITS.listDefaultLimit),
});

export const draftIdParamSchema = z.object({
  id: z.string().uuid(),
});
