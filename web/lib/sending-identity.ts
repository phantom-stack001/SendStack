import { normalizeEmail, validEmail } from "./ids";

function envTrim(name: string): string {
  return (process.env[name] ?? "").trim();
}

function parseCsvList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export type SendingIdentity = {
  fromEmail: string;
  replyToEmail: string;
  allowedLinkDomains: string[];
  testRecipientAllowlist: string[];
};

export function loadSendingIdentity(): SendingIdentity {
  return {
    fromEmail: normalizeEmail(envTrim("SENDSTACK_FROM_EMAIL")),
    replyToEmail: normalizeEmail(envTrim("SENDSTACK_REPLY_TO_EMAIL")),
    allowedLinkDomains: parseCsvList(envTrim("SENDSTACK_ALLOWED_LINK_DOMAINS")),
    testRecipientAllowlist: parseCsvList(envTrim("SENDSTACK_TEST_RECIPIENT_ALLOWLIST")).map(normalizeEmail),
  };
}

export type IdentityGap = {
  id: string;
  label: string;
  detail: string;
};

export function spacemailMailbox(): string {
  return normalizeEmail(envTrim("SENDSTACK_SMTP_USERNAME"));
}

export function identityComplianceGaps(identity = loadSendingIdentity()): IdentityGap[] {
  const gaps: IdentityGap[] = [];
  if (!identity.fromEmail || !validEmail(identity.fromEmail)) {
    gaps.push({
      id: "from_email",
      label: "Monitored From address",
      detail: "Set SENDSTACK_FROM_EMAIL to a verified, monitored mailbox. Do not use noreply defaults.",
    });
  }
  const mailbox = spacemailMailbox();
  if (mailbox && identity.fromEmail && identity.fromEmail !== mailbox) {
    gaps.push({
      id: "mailbox_from",
      label: "Spacemail mailbox From",
      detail:
        "SENDSTACK_FROM_EMAIL must match SENDSTACK_SMTP_USERNAME so messages send as the Spacemail mailbox.",
    });
  }
  // Reply-To and link-domain allowlist are optional (Spacemail webmail parity).
  return gaps;
}

export function identityConfigured(identity = loadSendingIdentity()): boolean {
  return identityComplianceGaps(identity).length === 0;
}

export function enforcedFromEmail(campaignFromEmail: string, identity = loadSendingIdentity()): string {
  if (!identity.fromEmail) {
    throw new Error("SENDSTACK_FROM_EMAIL is required before live sending.");
  }
  const mailbox = spacemailMailbox();
  if (mailbox && identity.fromEmail !== mailbox) {
    throw new Error(`From address must be the Spacemail mailbox (${mailbox}).`);
  }
  const requested = normalizeEmail(campaignFromEmail);
  if (requested && requested !== identity.fromEmail) {
    throw new Error(`From address must be ${identity.fromEmail}.`);
  }
  return identity.fromEmail;
}

/** Optional Reply-To from env. Empty string when unset — Spacemail omits Reply-To by default. */
export function enforcedReplyTo(identity = loadSendingIdentity()): string {
  return identity.replyToEmail || "";
}

export function isTestRecipientAllowed(email: string, identity = loadSendingIdentity()): boolean {
  const normalized = normalizeEmail(email);
  return identity.testRecipientAllowlist.includes(normalized);
}

export function publicSiteIdentity(identity = loadSendingIdentity()) {
  const contactEmail = identity.replyToEmail || identity.fromEmail || null;
  return {
    contactEmail,
    configured: Boolean(contactEmail),
  };
}
