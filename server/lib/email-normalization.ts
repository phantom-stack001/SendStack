const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize email for storage and uniqueness checks.
 * - Trim whitespace
 * - Lowercase entire address (documented account-level policy)
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const normalized = normalizeEmail(value);
  if (!normalized || normalized.length > 320) {
    return false;
  }
  return EMAIL_PATTERN.test(normalized);
}
