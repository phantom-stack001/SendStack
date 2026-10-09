import { isValidEmail, normalizeEmail } from "../lib/email-normalization.js";
import type { SubscriptionStatus } from "../validation/contacts.js";

export type EligibilityStatus =
  | "eligible"
  | "excluded_unsubscribed"
  | "excluded_suppressed"
  | "excluded_unknown_consent"
  | "excluded_invalid";

export type ContactCandidate = {
  contactId: string;
  email: string;
  subscriptionStatus: SubscriptionStatus;
};

export type EligibilityRow = {
  contactId: string | null;
  email: string;
  eligibilityStatus: EligibilityStatus;
  eligibilityReason: string;
};

export type EligibilitySummary = {
  selectedRaw: number;
  uniqueEmails: number;
  duplicates: number;
  eligible: number;
  excludedUnsubscribed: number;
  excludedSuppressed: number;
  excludedUnknownConsent: number;
  excludedInvalid: number;
  excludedTotal: number;
};

export function classifyContactEligibility(
  contact: ContactCandidate,
  suppressedEmails: Set<string>,
): EligibilityRow {
  const email = normalizeEmail(contact.email);
  if (!isValidEmail(email)) {
    return {
      contactId: contact.contactId,
      email,
      eligibilityStatus: "excluded_invalid",
      eligibilityReason: "invalid_email",
    };
  }
  if (suppressedEmails.has(email)) {
    return {
      contactId: contact.contactId,
      email,
      eligibilityStatus: "excluded_suppressed",
      eligibilityReason: "suppressed",
    };
  }
  if (contact.subscriptionStatus === "unsubscribed") {
    return {
      contactId: contact.contactId,
      email,
      eligibilityStatus: "excluded_unsubscribed",
      eligibilityReason: "unsubscribed",
    };
  }
  if (contact.subscriptionStatus === "subscribed") {
    return {
      contactId: contact.contactId,
      email,
      eligibilityStatus: "eligible",
      eligibilityReason: "subscribed",
    };
  }
  return {
    contactId: contact.contactId,
    email,
    eligibilityStatus: "excluded_unknown_consent",
    eligibilityReason: contact.subscriptionStatus,
  };
}

/**
 * Deduplicate by normalized email. When the same email appears multiple times,
 * keep the contact with the lexicographically smallest contact ID (deterministic).
 */
export function dedupeContactCandidates(candidates: ContactCandidate[]): {
  unique: ContactCandidate[];
  selectedRaw: number;
  duplicates: number;
} {
  const selectedRaw = candidates.length;
  const byEmail = new Map<string, ContactCandidate>();

  for (const candidate of candidates) {
    const email = normalizeEmail(candidate.email);
    const existing = byEmail.get(email);
    if (!existing || candidate.contactId < existing.contactId) {
      byEmail.set(email, { ...candidate, email });
    }
  }

  const unique = [...byEmail.values()];
  return {
    unique,
    selectedRaw,
    duplicates: Math.max(0, selectedRaw - unique.length),
  };
}

export function buildEligibilitySnapshot(
  candidates: ContactCandidate[],
  suppressedEmails: Set<string>,
): { rows: EligibilityRow[]; summary: EligibilitySummary } {
  const { unique, selectedRaw, duplicates } = dedupeContactCandidates(candidates);
  const rows = unique.map((contact) => classifyContactEligibility(contact, suppressedEmails));

  const summary: EligibilitySummary = {
    selectedRaw,
    uniqueEmails: unique.length,
    duplicates,
    eligible: 0,
    excludedUnsubscribed: 0,
    excludedSuppressed: 0,
    excludedUnknownConsent: 0,
    excludedInvalid: 0,
    excludedTotal: 0,
  };

  for (const row of rows) {
    if (row.eligibilityStatus === "eligible") summary.eligible += 1;
    else if (row.eligibilityStatus === "excluded_unsubscribed") summary.excludedUnsubscribed += 1;
    else if (row.eligibilityStatus === "excluded_suppressed") summary.excludedSuppressed += 1;
    else if (row.eligibilityStatus === "excluded_unknown_consent") summary.excludedUnknownConsent += 1;
    else if (row.eligibilityStatus === "excluded_invalid") summary.excludedInvalid += 1;
  }

  summary.excludedTotal =
    summary.excludedUnsubscribed +
    summary.excludedSuppressed +
    summary.excludedUnknownConsent +
    summary.excludedInvalid;

  return { rows, summary };
}
