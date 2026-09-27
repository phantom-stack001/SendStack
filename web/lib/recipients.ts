import { normalizeEmail, validEmail } from "./ids";

/** RFC 6761 / special-use and other live-invalid domains that must never receive production mail. */
const SPECIAL_USE_DOMAIN_SUFFIXES = [
  "test",
  "invalid",
  "local",
  "localhost",
  "example",
  "example.com",
  "example.net",
  "example.org",
] as const;

export function emailDomain(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at < 0) return "";
  return normalized.slice(at + 1);
}

export function isSpecialUseRecipientDomain(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return true;
  return SPECIAL_USE_DOMAIN_SUFFIXES.some(
    (suffix) => domain === suffix || domain.endsWith(`.${suffix}`),
  );
}

export type RecipientValidationResult =
  | { ok: true; email: string }
  | { ok: false; error: string };

export function validateLiveRecipient(email: string): RecipientValidationResult {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) {
    return { ok: false, error: "Enter a valid recipient email address." };
  }
  if (isSpecialUseRecipientDomain(normalized)) {
    return {
      ok: false,
      error: "Special-use domains (.test, .invalid, .local, .localhost, .example) cannot receive live email.",
    };
  }
  return { ok: true, email: normalized };
}
