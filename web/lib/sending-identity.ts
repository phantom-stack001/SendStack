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
  companyName: string;
  postalAddress: string;
  allowedLinkDomains: string[];
  testRecipientAllowlist: string[];
};

export function loadSendingIdentity(): SendingIdentity {
  return {
    fromEmail: normalizeEmail(envTrim("SENDSTACK_FROM_EMAIL")),
    replyToEmail: normalizeEmail(envTrim("SENDSTACK_REPLY_TO_EMAIL")),
    companyName: envTrim("SENDSTACK_COMPANY_NAME"),
    postalAddress: envTrim("SENDSTACK_POSTAL_ADDRESS"),
    allowedLinkDomains: parseCsvList(envTrim("SENDSTACK_ALLOWED_LINK_DOMAINS")),
    testRecipientAllowlist: parseCsvList(envTrim("SENDSTACK_TEST_RECIPIENT_ALLOWLIST")).map(normalizeEmail),
  };
}

export type IdentityGap = {
  id: string;
  label: string;
  detail: string;
};

export function identityComplianceGaps(identity = loadSendingIdentity()): IdentityGap[] {
  const gaps: IdentityGap[] = [];
  if (!identity.fromEmail || !validEmail(identity.fromEmail)) {
    gaps.push({
      id: "from_email",
      label: "Monitored From address",
      detail: "Set SENDSTACK_FROM_EMAIL to a verified, monitored mailbox. Do not use noreply defaults.",
    });
  }
  if (!identity.replyToEmail || !validEmail(identity.replyToEmail)) {
    gaps.push({
      id: "reply_to",
      label: "Reply-To address",
      detail: "Set SENDSTACK_REPLY_TO_EMAIL to a monitored inbox that can receive replies.",
    });
  }
  if (!identity.companyName) {
    gaps.push({
      id: "company_name",
      label: "Company name",
      detail: "Set SENDSTACK_COMPANY_NAME to the legal or trading name that appears in messages.",
    });
  }
  if (!identity.postalAddress) {
    gaps.push({
      id: "postal_address",
      label: "Postal address",
      detail: "Set SENDSTACK_POSTAL_ADDRESS to a real registered postal address for compliance footers.",
    });
  }
  if (!identity.allowedLinkDomains.length) {
    gaps.push({
      id: "allowed_link_domains",
      label: "Allowed link domains",
      detail: "Set SENDSTACK_ALLOWED_LINK_DOMAINS to a comma-separated allowlist of HTTP(S) link hosts.",
    });
  }
  return gaps;
}

export function identityConfigured(identity = loadSendingIdentity()): boolean {
  return identityComplianceGaps(identity).length === 0;
}

export function enforcedFromEmail(campaignFromEmail: string, identity = loadSendingIdentity()): string {
  if (!identity.fromEmail) {
    throw new Error("SENDSTACK_FROM_EMAIL is required before live sending.");
  }
  const requested = normalizeEmail(campaignFromEmail);
  if (requested && requested !== identity.fromEmail) {
    throw new Error(`From address must be ${identity.fromEmail}.`);
  }
  return identity.fromEmail;
}

export function enforcedReplyTo(identity = loadSendingIdentity()): string {
  if (!identity.replyToEmail) {
    throw new Error("SENDSTACK_REPLY_TO_EMAIL is required before live sending.");
  }
  return identity.replyToEmail;
}

export function isTestRecipientAllowed(email: string, identity = loadSendingIdentity()): boolean {
  const normalized = normalizeEmail(email);
  return identity.testRecipientAllowlist.includes(normalized);
}

export function publicSiteIdentity(identity = loadSendingIdentity()) {
  return {
    companyName: identity.companyName || null,
    postalAddress: identity.postalAddress || null,
    contactEmail: identity.replyToEmail || identity.fromEmail || null,
    configured: Boolean(identity.companyName && identity.postalAddress && (identity.replyToEmail || identity.fromEmail)),
  };
}
