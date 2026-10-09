import { z } from "zod";

export const IMPORT_LIMITS = {
  maxFileBytes: 2_000_000,
  maxRows: 10_000,
  previewRows: 25,
} as const;

export const csvColumnMappingSchema = z.object({
  email: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  phone: z.string().optional(),
});

export const importPreviewSchema = z.object({
  csvText: z.string().min(1).max(IMPORT_LIMITS.maxFileBytes),
});

export const importContactsSchema = z.object({
  csvText: z.string().min(1).max(IMPORT_LIMITS.maxFileBytes),
  mapping: csvColumnMappingSchema,
});
