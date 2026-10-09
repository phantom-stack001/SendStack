import { describe, expect, it } from "vitest";

import {
  EMPTY_TIPTAP_DOC,
  htmlToPlainText,
  processDraftContent,
  sanitizeEmailHtml,
  validateTiptapDocument,
} from "../lib/email-content.js";

describe("email content", () => {
  it("accepts a valid tiptap document", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    };
    expect(validateTiptapDocument(doc)).toEqual(doc);
  });

  it("rejects script payloads in generated html", () => {
    const malicious = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "<script>alert(1)</script>" }],
        },
      ],
    };
    const processed = processDraftContent(malicious);
    expect(processed.bodyHtml).not.toContain("<script");
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("generates plain text from html", () => {
    const processed = processDraftContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Line one" }],
        },
      ],
    });
    expect(processed.bodyText).toContain("Line one");
    expect(htmlToPlainText("<p>Hello</p>")).toBe("Hello");
  });

  it("normalizes invalid documents to empty doc", () => {
    const processed = processDraftContent({ type: "invalid" });
    expect(processed.contentJson.type).toBe("doc");
    expect(EMPTY_TIPTAP_DOC.type).toBe("doc");
  });
});
