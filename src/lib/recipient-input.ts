const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecipient(value: string) {
  return value.trim().toLowerCase();
}

export function isRecipientSyntaxValid(value: string) {
  const email = normalizeRecipient(value);
  return email.length > 0 && email.length <= 320 && EMAIL_PATTERN.test(email);
}

export function parseRecipientText(value: string) {
  return value
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export type RecipientFieldName = "to" | "cc" | "bcc";

export type RecipientDraft = {
  to: string[];
  cc: string[];
  bcc: string[];
};

export function addRecipients(current: string[], raw: string) {
  const invalid: string[] = [];
  const next = [...current];
  const seen = new Set(current.map(normalizeRecipient));
  for (const part of parseRecipientText(raw)) {
    if (!isRecipientSyntaxValid(part)) {
      invalid.push(part);
      continue;
    }
    const email = normalizeRecipient(part);
    if (seen.has(email)) continue;
    seen.add(email);
    next.push(email);
  }
  return { next, invalid };
}

export function recipientFieldError(fields: RecipientDraft) {
  const buckets: Record<RecipientFieldName, string[]> = {
    to: fields.to.map(normalizeRecipient),
    cc: fields.cc.map(normalizeRecipient),
    bcc: fields.bcc.map(normalizeRecipient),
  };
  if (buckets.to.length === 0) return "Add at least one To recipient.";
  const seen = new Map<string, RecipientFieldName>();
  for (const key of ["to", "cc", "bcc"] as const) {
    for (const email of buckets[key]) {
      const previous = seen.get(email);
      if (previous) {
        return `${email} is listed in both ${label(previous)} and ${label(key)}.`;
      }
      seen.set(email, key);
    }
  }
  if (seen.size > 3) return "A message can include at most 3 recipients.";
  return null;
}

function label(field: RecipientFieldName) {
  if (field === "to") return "To";
  if (field === "cc") return "Cc";
  return "Bcc";
}
