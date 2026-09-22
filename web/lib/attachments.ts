export const ATTACHMENT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 3;
export const ATTACHMENT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const ALLOWED_BY_EXTENSION: Record<string, string[]> = {
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  pdf: ["application/pdf"],
  zip: ["application/zip", "application/x-zip-compressed"],
};

export type AttachmentValidationInput = {
  filename: string;
  contentType: string;
  byteSize: number;
  existingCount: number;
  existingTotalBytes: number;
};

export type AttachmentValidationResult =
  | { ok: true; filename: string; contentType: string; extension: string }
  | { ok: false; error: string };

function extensionOf(filename: string): string {
  const base = filename.trim().split(/[/\\]/).pop() || "";
  const parts = base.split(".");
  if (parts.length < 2) return "";
  return parts.pop()!.toLowerCase();
}

function sanitizeFilename(filename: string): string {
  const base = filename.trim().split(/[/\\]/).pop() || "attachment";
  return base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180) || "attachment";
}

export function validateCampaignAttachment(input: AttachmentValidationInput): AttachmentValidationResult {
  const filename = sanitizeFilename(input.filename);
  const extension = extensionOf(filename);
  const allowedTypes = ALLOWED_BY_EXTENSION[extension];
  if (!allowedTypes) {
    return { ok: false, error: "Allowed attachments: PNG, JPG, GIF, WebP, PDF, or ZIP." };
  }

  const contentType = (input.contentType || "").split(";")[0].trim().toLowerCase() || allowedTypes[0];
  if (!allowedTypes.includes(contentType) && contentType !== "application/octet-stream") {
    return { ok: false, error: `File type “${contentType || "unknown"}” is not allowed for .${extension} files.` };
  }

  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0) {
    return { ok: false, error: "The attachment is empty." };
  }
  if (input.byteSize > ATTACHMENT_MAX_FILE_BYTES) {
    return { ok: false, error: "Each attachment must be 5 MB or smaller." };
  }
  if (input.existingCount >= ATTACHMENT_MAX_COUNT) {
    return { ok: false, error: "A campaign can have at most 3 attachments." };
  }
  if (input.existingTotalBytes + input.byteSize > ATTACHMENT_MAX_TOTAL_BYTES) {
    return { ok: false, error: "Attachments for one campaign cannot exceed 10 MB total." };
  }

  return {
    ok: true,
    filename,
    contentType: allowedTypes.includes(contentType) ? contentType : allowedTypes[0],
    extension,
  };
}

export function attachmentMeta(row: {
  id: string;
  filename: string;
  content_type: string;
  byte_size: number | string;
}) {
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    byte_size: Number(row.byte_size),
  };
}
