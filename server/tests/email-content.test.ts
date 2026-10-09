import { describe, expect, it } from "vitest";

import {
  EMPTY_TIPTAP_DOC,
  htmlToPlainText,
  processDraftContent,
  sanitizeEmailHtml,
  tiptapJsonToHtml,
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

  it("generates and preserves bullet list html", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "First" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Second" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(validateTiptapDocument(doc)).toEqual(doc);
    const html = tiptapJsonToHtml(doc);
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("First");
    expect(html).toContain("Second");
    const processed = processDraftContent(doc);
    expect(processed.bodyHtml).toContain("<ul");
    expect(processed.bodyHtml).toContain("<li");
    expect(processed.bodyText).toContain("First");
    expect(processed.bodyText).toContain("Second");
  });

  it("generates and preserves ordered list html", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Step one" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const html = tiptapJsonToHtml(doc);
    expect(html).toContain("<ol");
    expect(html).toContain("Step one");
    expect(sanitizeEmailHtml(html)).toContain("<ol");
  });

  it("sanitizes list html without removing structure", () => {
    const safe = sanitizeEmailHtml(
      "<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul><ol><li><p>One</p></li></ol>",
    );
    expect(safe).toContain("<ul>");
    expect(safe).toContain("<ol>");
    expect(safe).toContain("Alpha");
    expect(safe).not.toContain("<script");
  });
});
