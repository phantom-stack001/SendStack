export const ATTACHMENT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 3;
export const ATTACHMENT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const ALLOWED_BY_EXTENSION: Record<string, { mime: string[]; magic: Array<(bytes: Buffer) => boolean> }> = {
  png: {
    mime: ["image/png"],
    magic: [(bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  },
  jpg: {
    mime: ["image/jpeg"],
    magic: [(bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  },
  jpeg: {
    mime: ["image/jpeg"],
    magic: [(bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  },
  gif: {
    mime: ["image/gif"],
    magic: [
      (bytes) => bytes.length >= 6 && (bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) || bytes.subarray(0, 6).equals(Buffer.from("GIF89a"))),
    ],
  },
  webp: {
    mime: ["image/webp"],
    magic: [
      (bytes) =>
        bytes.length >= 12 &&
        bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
        bytes.subarray(8, 12).equals(Buffer.from("WEBP")),
    ],
  },
  pdf: {
    mime: ["application/pdf"],
    magic: [(bytes) => bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))],
  },
};

const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "gz", "tgz", "tar"]);

export type AttachmentValidationInput = {
  filename: string;
  contentType: string;
  byteSize: number;
  existingCount: number;
  existingTotalBytes: number;
  bytes?: Buffer | Uint8Array;
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

function asBuffer(bytes?: Buffer | Uint8Array): Buffer | null {
  if (!bytes) return null;
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

export function validateCampaignAttachment(input: AttachmentValidationInput): AttachmentValidationResult {
  const filename = sanitizeFilename(input.filename);
  const extension = extensionOf(filename);

  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return { ok: false, error: "Archive attachments (ZIP and similar) are not allowed." };
  }

  const allowed = ALLOWED_BY_EXTENSION[extension];
  if (!allowed) {
    return { ok: false, error: "Allowed attachments: PNG, JPG, GIF, WebP, or PDF." };
  }

  const contentType = (input.contentType || "").split(";")[0].trim().toLowerCase() || allowed.mime[0];
  if (!allowed.mime.includes(contentType) && contentType !== "application/octet-stream") {
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

  const buffer = asBuffer(input.bytes);
  if (buffer && !allowed.magic.some((check) => check(buffer))) {
    return { ok: false, error: `File contents do not match a valid .${extension} signature.` };
  }

  return {
    ok: true,
    filename,
    contentType: allowed.mime.includes(contentType) ? contentType : allowed.mime[0],
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

export function isArchiveAttachmentFilename(filename: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(filename));
}
