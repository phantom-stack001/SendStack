import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  attachmentMeta,
  validateCampaignAttachment,
} from "../lib/attachments";

describe("campaign attachment validation", () => {
  it("accepts allowed image and pdf files with matching magic bytes", () => {
    const image = validateCampaignAttachment({
      filename: "hero.PNG",
      contentType: "image/png",
      byteSize: 8,
      existingCount: 0,
      existingTotalBytes: 0,
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    expect(image.ok).toBe(true);
    if (image.ok) {
      expect(image.filename).toBe("hero.PNG");
      expect(image.contentType).toBe("image/png");
      expect(image.extension).toBe("png");
    }

    const pdf = validateCampaignAttachment({
      filename: "brochure.pdf",
      contentType: "application/pdf",
      byteSize: 10,
      existingCount: 1,
      existingTotalBytes: 8,
      bytes: Buffer.from("%PDF-1.7xx"),
    });
    expect(pdf.ok).toBe(true);
  });

  it("rejects zip archives and disallowed types", () => {
    expect(
      validateCampaignAttachment({
        filename: "pack.zip",
        contentType: "application/zip",
        byteSize: 4096,
        existingCount: 0,
        existingTotalBytes: 0,
      }).ok,
    ).toBe(false);

    expect(
      validateCampaignAttachment({
        filename: "payload.exe",
        contentType: "application/octet-stream",
        byteSize: 100,
        existingCount: 0,
        existingTotalBytes: 0,
      }).ok,
    ).toBe(false);

    expect(
      validateCampaignAttachment({
        filename: "big.pdf",
        contentType: "application/pdf",
        byteSize: ATTACHMENT_MAX_FILE_BYTES + 1,
        existingCount: 0,
        existingTotalBytes: 0,
        bytes: Buffer.from("%PDF-1.4"),
      }).ok,
    ).toBe(false);
  });

  it("enforces per-campaign count and total size", () => {
    const tooMany = validateCampaignAttachment({
      filename: "extra.png",
      contentType: "image/png",
      byteSize: 10,
      existingCount: ATTACHMENT_MAX_COUNT,
      existingTotalBytes: 0,
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toMatch(/at most 3/i);

    const tooHeavy = validateCampaignAttachment({
      filename: "more.pdf",
      contentType: "application/pdf",
      byteSize: 1024,
      existingCount: 1,
      existingTotalBytes: ATTACHMENT_MAX_TOTAL_BYTES,
      bytes: Buffer.from("%PDF-1.4"),
    });
    expect(tooHeavy.ok).toBe(false);
    if (!tooHeavy.ok) expect(tooHeavy.error).toMatch(/10 MB/i);
  });

  it("maps attachment rows to metadata without content", () => {
    expect(
      attachmentMeta({
        id: "att_1",
        filename: "guide.pdf",
        content_type: "application/pdf",
        byte_size: "2048",
      }),
    ).toEqual({
      id: "att_1",
      filename: "guide.pdf",
      content_type: "application/pdf",
      byte_size: 2048,
    });
  });
});
