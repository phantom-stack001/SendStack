import { z } from "zod";

import { isValidEmail, normalizeEmail } from "../lib/email-normalization.js";

export const SUBSCRIPTION_STATUSES = [
  "subscribed",
  "unsubscribed",
  "pending",
  "unknown",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUPPRESSION_REASONS = [
  "unsubscribed",
  "hard_bounce",
  "complaint",
  "manual_block",
] as const;

export const CONTACT_LIMITS = {
  firstNameMax: 120,
  lastNameMax: 120,
  companyMax: 200,
  phoneMax: 40,
  listNameMax: 120,
  listDescriptionMax: 500,
  consentSourceMax: 200,
  listDefaultLimit: 25,
  listMaxLimit: 100,
  bulkMaxIds: 200,
} as const;

const emailSchema = z
  .string()
  .min(1, "Email is required")
  .max(320)
  .transform(normalizeEmail)
  .refine(isValidEmail, "Invalid email address");

export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

export const createContactSchema = z
  .object({
    email: emailSchema,
    firstName: z.string().max(CONTACT_LIMITS.firstNameMax).optional(),
    lastName: z.string().max(CONTACT_LIMITS.lastNameMax).optional(),
    company: z.string().max(CONTACT_LIMITS.companyMax).optional(),
    phone: z.string().max(CONTACT_LIMITS.phoneMax).optional(),
    subscriptionStatus: subscriptionStatusSchema.optional(),
    consentSource: z.string().max(CONTACT_LIMITS.consentSourceMax).optional(),
    consentMethod: z.string().max(120).optional(),
    consentOccurredAt: z.string().datetime().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.subscriptionStatus === "subscribed") {
      if (!data.consentSource?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Consent source is required when marking a contact as subscribed",
          path: ["consentSource"],
        });
      }
      if (!data.consentOccurredAt) {
        ctx.addIssue({
          code: "custom",
          message: "Consent timestamp is required when marking a contact as subscribed",
          path: ["consentOccurredAt"],
        });
      }
    }
  });

export const updateContactSchema = z
  .object({
    email: emailSchema.optional(),
    firstName: z.string().max(CONTACT_LIMITS.firstNameMax).optional(),
    lastName: z.string().max(CONTACT_LIMITS.lastNameMax).optional(),
    company: z.string().max(CONTACT_LIMITS.companyMax).optional(),
    phone: z.string().max(CONTACT_LIMITS.phoneMax).optional(),
    subscriptionStatus: subscriptionStatusSchema.optional(),
    consentSource: z.string().max(CONTACT_LIMITS.consentSourceMax).optional(),
    consentMethod: z.string().max(120).optional(),
    consentOccurredAt: z.string().datetime().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.subscriptionStatus === "subscribed") {
      if (!data.consentSource?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Consent source is required when marking a contact as subscribed",
          path: ["consentSource"],
        });
      }
      if (!data.consentOccurredAt) {
        ctx.addIssue({
          code: "custom",
          message: "Consent timestamp is required when marking a contact as subscribed",
          path: ["consentOccurredAt"],
        });
      }
    }
  });

export const listContactsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONTACT_LIMITS.listMaxLimit)
    .default(CONTACT_LIMITS.listDefaultLimit),
  q: z.string().max(200).optional(),
  status: subscriptionStatusSchema.optional(),
  listId: z.string().uuid().optional(),
  sort: z.enum(["created_at_desc", "created_at_asc", "email_asc"]).default("created_at_desc"),
});

export const contactIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const createContactListSchema = z.object({
  name: z.string().trim().min(1).max(CONTACT_LIMITS.listNameMax),
  description: z.string().max(CONTACT_LIMITS.listDescriptionMax).optional(),
});

export const updateContactListSchema = z.object({
  name: z.string().trim().min(1).max(CONTACT_LIMITS.listNameMax).optional(),
  description: z.string().max(CONTACT_LIMITS.listDescriptionMax).optional(),
});

export const listMembersBodySchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(CONTACT_LIMITS.bulkMaxIds),
});

export const bulkContactActionSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(CONTACT_LIMITS.bulkMaxIds),
  listId: z.string().uuid().optional(),
});

export const createSuppressionSchema = z.object({
  email: emailSchema,
  reason: z.enum(SUPPRESSION_REASONS),
});

export const listSuppressionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONTACT_LIMITS.listMaxLimit)
    .default(CONTACT_LIMITS.listDefaultLimit),
  q: z.string().max(200).optional(),
  reason: z.enum(SUPPRESSION_REASONS).optional(),
});
