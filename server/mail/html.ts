import sanitizeHtml from "sanitize-html";

const INBOUND_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "h1",
    "h2",
    "h3",
    "h4",
    "ul",
    "ol",
    "li",
    "blockquote",
    "a",
    "pre",
    "code",
    "div",
    "span",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "hr",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: (_tagName, attribs) => {
      const href = attribs.href ?? "";
      const allowed = /^(https?:|mailto:)/i.test(href);
      return {
        tagName: "a",
        attribs: {
          ...(allowed ? { href } : {}),
          ...(attribs.title ? { title: attribs.title } : {}),
          rel: "noopener noreferrer",
          target: "_blank",
        },
      };
    },
  },
};

export function sanitizeInboundHtml(html: string) {
  return sanitizeHtml(html, INBOUND_SANITIZE_OPTIONS).trim();
}

export function plainTextToSafeHtml(text: string) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const body = escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, "<br />")}</p>`)
    .join("");
  return sanitizeInboundHtml(body);
}
