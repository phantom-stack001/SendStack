import { parse as parsePublicSuffix } from "tldts";
import { normalizeEmail } from "./ids";
import { loadSendingIdentity, type SendingIdentity } from "./sending-identity";
import { validateEmailContent } from "./templates";

/** Only these merge tokens are permitted inside href / URL fields. */
const SAFE_URL_MERGE_TOKENS = new Set(["{{unsubscribe_url}}"]);

/**
 * True when the hostname is itself a public suffix (e.g. github.io, co.uk, com)
 * and therefore not a registrable domain that can be allowlisted alone.
 */
export function isPublicSuffixHostname(hostname: string): boolean {
  const domain = hostname.trim().toLowerCase().replace(/^\.+/, "");
  if (!domain) return true;
  const parsed = parsePublicSuffix(domain, { allowPrivateDomains: true });
  if (!parsed.publicSuffix) {
    // Single-label / unknown TLD — treat as public suffix (dangerously broad).
    return !domain.includes(".") || domain.split(".").filter(Boolean).length < 2;
  }
  // Exact public-suffix match (no registrable domain beneath it).
  return parsed.domain === null || parsed.domain === parsed.publicSuffix || domain === parsed.publicSuffix;
}

export function validateAllowedLinkDomains(domains: string[]): string[] {
  const errors: string[] = [];
  for (const raw of domains) {
    const domain = raw.trim().toLowerCase().replace(/^\.+/, "");
    if (!domain) {
      errors.push("Allowed link domain entries cannot be empty.");
      continue;
    }
    if (domain.includes("/") || domain.includes(":") || domain.includes(" ")) {
      errors.push(`Allowed link domain “${raw}” must be a hostname only.`);
      continue;
    }
    if (isPublicSuffixHostname(domain)) {
      errors.push(`Allowed link domain “${raw}” is a public suffix or dangerously broad hostname.`);
    }
  }
  return errors;
}

/**
 * Parse SENDSTACK_PUBLIC_URL as a strict https origin.
 * Rejects credentials, query, fragment, and non-root paths.
 */
export function parsePublicOrigin(url: string): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    throw new Error("SENDSTACK_PUBLIC_URL is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("SENDSTACK_PUBLIC_URL must be a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("SENDSTACK_PUBLIC_URL must use https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("SENDSTACK_PUBLIC_URL must not include credentials.");
  }
  if (parsed.search) {
    throw new Error("SENDSTACK_PUBLIC_URL must not include a query string.");
  }
  if (parsed.hash) {
    throw new Error("SENDSTACK_PUBLIC_URL must not include a fragment.");
  }
  const path = parsed.pathname || "/";
  if (path !== "/" && path !== "") {
    throw new Error("SENDSTACK_PUBLIC_URL path must be empty or `/` only.");
  }
  if (!parsed.hostname) {
    throw new Error("SENDSTACK_PUBLIC_URL must include a hostname.");
  }
  return parsed.origin;
}

type ExtractedLink = { raw: string; kind: "href" | "bare" };

function extractLinks(html: string, text: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  // Quoted and unquoted hrefs.
  for (const match of html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw) links.push({ raw, kind: "href" });
  }
  for (const match of `${html}\n${text}`.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    links.push({ raw: match[0], kind: "bare" });
  }
  // Protocol-relative links.
  for (const match of `${html}\n${text}`.matchAll(/(?:^|[\s"'=(])(\/\/[^\s"'<>]+)/gi)) {
    links.push({ raw: match[1], kind: "bare" });
  }
  return links;
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export type LinkValidation =
  | { ok: true; host: string | null; skipped?: "merge" | "mailto" | "anchor" }
  | { ok: false; error: string };

export function validateCampaignLink(raw: string, allowedDomains: string[]): LinkValidation {
  const trimmed = decodeBasicEntities(raw.trim());
  if (!trimmed) return { ok: false, error: "Empty href is not allowed." };

  if (trimmed.startsWith("{{") || trimmed.startsWith("{{{")) {
    if (SAFE_URL_MERGE_TOKENS.has(trimmed)) {
      return { ok: true, host: null, skipped: "merge" };
    }
    return {
      ok: false,
      error: `Merge token “${raw}” is not permitted in URLs/hrefs. Only {{unsubscribe_url}} is allowed.`,
    };
  }
  if (trimmed.startsWith("#")) return { ok: true, host: null, skipped: "anchor" };
  if (/^mailto:/i.test(trimmed)) return { ok: true, host: null, skipped: "mailto" };

  // Reject mixed merge tokens inside otherwise absolute URLs/hrefs.
  if (/\{\{|\}\}/.test(trimmed)) {
    const onlySafe =
      SAFE_URL_MERGE_TOKENS.has(trimmed) ||
      [...SAFE_URL_MERGE_TOKENS].some((token) => trimmed === token);
    if (!onlySafe) {
      return {
        ok: false,
        error: `Unsafe merge token in link href: ${raw}`,
      };
    }
  }

  let candidate = trimmed;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // Try decoding once for encoded URLs.
    try {
      parsed = new URL(decodeURIComponent(candidate));
    } catch {
      return { ok: false, error: `Malformed or unclassifiable link: ${raw}` };
    }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Disallowed link protocol in ${raw}` };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, error: `Link is missing a hostname: ${raw}` };

  // Empty allowlist = Spacemail-style: any http(s) host is fine.
  if (!allowedDomains.length) return { ok: true, host };

  const allowed = allowedDomains.map((domain) => domain.toLowerCase());
  const permitted = allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!permitted) {
    return { ok: false, error: `Link host “${host}” is not in SENDSTACK_ALLOWED_LINK_DOMAINS.` };
  }
  return { ok: true, host };
}

/** True when an author included a visible {{unsubscribe_url}} (optional for Spacemail-style sends). */
export function hasVisibleUnsubscribe(html: string, text: string): boolean {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const hiddenStripped = withoutComments
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+hidden[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, "");
  const htmlVisible =
    /<a\b[^>]*href\s*=\s*["']?\{\{unsubscribe_url\}\}["']?[^>]*>[\s\S]*?<\/a>/i.test(hiddenStripped);
  const textVisible = /\{\{unsubscribe_url\}\}/.test(text);
  return htmlVisible && textVisible;
}

export type PreflightInput = {
  subject: string;
  htmlBody: string;
  textBody: string;
  fromEmail: string;
  fromName: string;
  attachmentExtensions?: string[];
  attachmentCount?: number;
  identity?: SendingIdentity;
  requirePublicHttps?: boolean;
};

export type PreflightResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Launch checks aligned with Spacemail webmail: subject, from name, mailbox From,
 * and unsafe HTML. Reply-To, link allowlists, fake-thread subjects, placeholders,
 * plain-text requirement, unsubscribe, and archive attachments do not block launch.
 */
export function runCampaignPreflight(input: PreflightInput): PreflightResult {
  const identity = input.identity ?? loadSendingIdentity();
  const errors: string[] = [];
  const subject = input.subject.trim();
  const htmlBody = input.htmlBody ?? "";
  const textBody = input.textBody ?? "";

  if (!subject) errors.push("Subject is required.");
  if (!input.fromName.trim()) errors.push("From name is required.");
  if (!htmlBody.trim() && !textBody.trim()) {
    errors.push("Message body is required (HTML or plain text).");
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
  const mailbox = normalizeEmail((process.env.SENDSTACK_SMTP_USERNAME ?? "").trim());
  if (mailbox && identity.fromEmail && identity.fromEmail !== mailbox) {
    errors.push(`SENDSTACK_FROM_EMAIL must match the Spacemail mailbox (${mailbox}).`);
  }

  if (input.requirePublicHttps) {
    try {
      parsePublicOrigin(process.env.SENDSTACK_PUBLIC_URL ?? "");
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : "SENDSTACK_PUBLIC_URL must be a valid HTTPS origin before live direct/test email.",
      );
    }
  }

  // Reject unsafe URL schemes. Host allowlist is optional (empty = any https host).
  for (const link of extractLinks(htmlBody, textBody)) {
    const result = validateCampaignLink(link.raw, identity.allowedLinkDomains);
    if (!result.ok) errors.push(result.error);
  }

  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true };
}
