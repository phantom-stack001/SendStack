import { loadSendingIdentity, type SendingIdentity } from "./sending-identity";
import { validateEmailContent } from "./templates";

const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /replace this (text|copy|section)/i, label: "placeholder copy" },
  { pattern: /write your message/i, label: "placeholder message prompt" },
  { pattern: /placeholder text for legal review/i, label: "legal placeholder text" },
  { pattern: /\[street\],\s*\[city\],\s*\[country\]/i, label: "placeholder postal address" },
  { pattern: /\[your (company|address|name)\]/i, label: "bracketed placeholder" },
  { pattern: /lorem ipsum/i, label: "lorem ipsum seed content" },
  { pattern: /todo:\s*replace/i, label: "todo placeholder" },
  { pattern: /sample (subject|message|campaign)/i, label: "sample seed content" },
];

const FAKE_THREAD_SUBJECT = /^(re|fw|fwd)\s*:/i;

function extractHttpLinks(html: string, text: string): string[] {
  const combined = `${html}\n${text}`;
  const hrefs = [...combined.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  const bare = [...combined.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map((match) => match[0]);
  return [...new Set([...hrefs, ...bare])];
}

function hostFromUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("{{") || trimmed.startsWith("mailto:") || trimmed.startsWith("#")) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type PreflightInput = {
  subject: string;
  htmlBody: string;
  textBody: string;
  fromEmail: string;
  fromName: string;
  attachmentExtensions?: string[];
  identity?: SendingIdentity;
};

export type PreflightResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function runCampaignPreflight(input: PreflightInput): PreflightResult {
  const identity = input.identity ?? loadSendingIdentity();
  const errors: string[] = [];
  const subject = input.subject.trim();
  const htmlBody = input.htmlBody ?? "";
  const textBody = input.textBody ?? "";
  const haystack = `${subject}\n${htmlBody}\n${textBody}`;

  if (!subject) errors.push("Subject is required.");
  if (!input.fromName.trim()) errors.push("From name is required.");
  if (!textBody.trim()) errors.push("A plain-text part is required.");

  if (FAKE_THREAD_SUBJECT.test(subject)) {
    errors.push('Subjects cannot begin with "RE:" or "FW:" — SendStack is not a reply-thread system.');
  }

  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(haystack)) {
      errors.push(`Campaign content still contains ${label}. Replace seed/placeholder copy before launch.`);
    }
  }

  try {
    validateEmailContent(htmlBody, textBody);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Campaign content is invalid.");
  }

  if (!identity.fromEmail) {
    errors.push("SENDSTACK_FROM_EMAIL must be configured before launch.");
  } else if (input.fromEmail && input.fromEmail !== identity.fromEmail) {
    errors.push(`From address must be the enforced sender (${identity.fromEmail}).`);
  }

  if (!identity.replyToEmail) {
    errors.push("SENDSTACK_REPLY_TO_EMAIL must be configured before launch.");
  }
  if (!identity.companyName) {
    errors.push("SENDSTACK_COMPANY_NAME must be configured before launch.");
  }
  if (!identity.postalAddress) {
    errors.push("SENDSTACK_POSTAL_ADDRESS must be configured before launch.");
  }
  if (!identity.allowedLinkDomains.length) {
    errors.push("SENDSTACK_ALLOWED_LINK_DOMAINS must be configured before launch.");
  }

  const allowed = new Set(identity.allowedLinkDomains.map((domain) => domain.toLowerCase()));
  for (const link of extractHttpLinks(htmlBody, textBody)) {
    const host = hostFromUrl(link);
    if (!host) continue;
    const permitted = [...allowed].some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!permitted) {
      errors.push(`Link host “${host}” is not in SENDSTACK_ALLOWED_LINK_DOMAINS.`);
    }
  }

  for (const extension of input.attachmentExtensions ?? []) {
    if (extension === "zip" || extension === "rar" || extension === "7z" || extension === "gz") {
      errors.push("Archive attachments are not allowed. Remove ZIP/archive files before launch.");
    }
  }

  if (!htmlBody.includes("{{unsubscribe_url}}") && !htmlBody.includes("{{{RESEND_UNSUBSCRIBE_URL}}}")) {
    // validateEmailContent already covers merge token; keep explicit for clarity when HTML empty
  }

  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true };
}
