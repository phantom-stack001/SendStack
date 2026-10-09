/**
 * Bounce classification helpers for simulated admin feedback and tests.
 * Spacemail SMTP has no delivery webhooks; acceptance is recorded at SMTP submit time.
 */

export type BounceEvent = {
  type?: string;
  data?: {
    bounce?: {
      type?: string;
      subType?: string;
      sub_type?: string;
      message?: string;
    };
  };
};

/**
 * Only a permanent bounce justifies a protected, permanent suppression.
 *
 * A transient bounce (full mailbox, greylisting, throttling) must not destroy a
 * legitimate address: protected suppressions cannot be cleared by the removal APIs,
 * so treating a soft bounce as hard is unrecoverable in-app.
 * A missing classification is treated as permanent, which protects sending
 * reputation rather than continuing to mail an address that may be dead.
 */
export function isPermanentBounce(event: BounceEvent): boolean {
  const raw = (event.data?.bounce?.type ?? "").trim().toLowerCase();
  if (!raw) return true;
  if (raw === "transient" || raw === "soft" || raw === "undetermined") return false;
  return true;
}
