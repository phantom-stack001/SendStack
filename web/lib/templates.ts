const ALLOWED_MERGE_FIELDS = new Set(["first_name", "last_name", "email", "unsubscribe_url"]);

const UNSAFE_EMAIL_HTML = [
  /<\s*(script|iframe|object|embed|form|input|button|svg|math)\b/i,
  /\bon[a-z]+\s*=/i,
  /(?:javascript|vbscript|file|data)\s*:/i,
  /<\s*meta\b[^>]*http-equiv\s*=\s*['"]?refresh/i,
  /@import\b/i,
];

export function renderTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

export function validateEmailContent(htmlBody: string, textBody: string): void {
  if (UNSAFE_EMAIL_HTML.some((pattern) => pattern.test(htmlBody))) {
    throw new Error("Message HTML contains active or unsafe content");
  }
  const mergeFields = new Set(
    [...`${htmlBody}\n${textBody}`.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((match) => match[1]),
  );
  for (const field of mergeFields) {
    if (!ALLOWED_MERGE_FIELDS.has(field)) {
      throw new Error(`Unknown personalization field: ${field}`);
    }
  }
  if (!htmlBody.includes("{{unsubscribe_url}}")) {
    throw new Error("Every message must include a visible unsubscribe link");
  }
  if (!textBody.includes("{{unsubscribe_url}}")) {
    throw new Error("The plain-text version must include the unsubscribe link");
  }
}
