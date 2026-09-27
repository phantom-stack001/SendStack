/** Message statuses that must not be overwritten by later delivered/sent events. */
export const TERMINAL_MESSAGE_STATUSES = new Set([
  "bounced",
  "complained",
  "suppressed",
  "unsubscribed",
  "failed",
]);

/** Recipient statuses that must not be overwritten by later delivered/sent events. */
export const TERMINAL_RECIPIENT_STATUSES = new Set([
  "bounced",
  "complained",
  "suppressed",
  "failed",
  "cancelled",
]);

export type WebhookDerivedStatus =
  | "submitted"
  | "delivered"
  | "delayed"
  | "bounced"
  | "complained"
  | "suppressed"
  | "unsubscribed"
  | "failed"
  | null;

export function statusFromResendEvent(eventType: string | undefined): WebhookDerivedStatus {
  switch (eventType) {
    case "email.sent":
      return "submitted";
    case "email.delivered":
      return "delivered";
    case "email.delivery_delayed":
      return "delayed";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.suppressed":
      return "suppressed";
    case "email.failed":
      return "failed";
    case "contact.updated":
      return null;
    default:
      return null;
  }
}

export function recipientStatusFromMessageStatus(status: WebhookDerivedStatus): string | null {
  switch (status) {
    case "submitted":
    case "delivered":
    case "delayed":
      return status === "delivered" ? "sent" : status === "delayed" ? "delayed" : "sent";
    case "bounced":
      return "bounced";
    case "complained":
      return "complained";
    case "suppressed":
      return "suppressed";
    case "unsubscribed":
      return "suppressed";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export function canTransitionMessageStatus(current: string | null | undefined, next: string): boolean {
  if (!current) return true;
  if (current === next) return true;
  if (TERMINAL_MESSAGE_STATUSES.has(current)) return false;
  if (next === "delayed" && (current === "delivered" || TERMINAL_MESSAGE_STATUSES.has(current))) {
    return false;
  }
  if ((next === "submitted" || next === "delivered" || next === "delayed") && TERMINAL_MESSAGE_STATUSES.has(current)) {
    return false;
  }
  return true;
}

export function canTransitionRecipientStatus(current: string | null | undefined, next: string): boolean {
  if (!current) return true;
  if (current === next) return true;
  if (TERMINAL_RECIPIENT_STATUSES.has(current)) return false;
  if ((next === "sent" || next === "processing" || next === "delayed") && TERMINAL_RECIPIENT_STATUSES.has(current)) {
    return false;
  }
  return true;
}

/** Statuses that count against the daily delivery volume limit. */
export const DAILY_LIMIT_MESSAGE_STATUSES = [
  "captured",
  "submitted",
  "delivered",
  "delayed",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const;
