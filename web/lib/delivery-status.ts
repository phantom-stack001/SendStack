/** Ranked message statuses — higher ranks must never regress to lower ones. */
export const MESSAGE_STATUS_RANK: Record<string, number> = {
  captured: 10,
  submission_unknown: 20,
  submitted: 30,
  delayed: 40,
  delivered: 50,
  failed: 100,
  bounced: 100,
  complained: 100,
  suppressed: 100,
  unsubscribed: 100,
};

export const RECIPIENT_STATUS_RANK: Record<string, number> = {
  queued: 10,
  processing: 20,
  submission_unknown: 25,
  cancel_requested: 28,
  outcome_pending: 29,
  delayed: 35,
  sent: 40,
  failed: 100,
  bounced: 100,
  complained: 100,
  suppressed: 100,
  cancelled: 100,
};

export const TERMINAL_MESSAGE_STATUSES = new Set([
  "bounced",
  "complained",
  "suppressed",
  "unsubscribed",
  "failed",
]);

export const TERMINAL_RECIPIENT_STATUSES = new Set([
  "bounced",
  "complained",
  "suppressed",
  "failed",
  "cancelled",
]);

/** Pending cancellation can still be corrected by delivery outcomes. */
export const CANCELLATION_PENDING_RECIPIENT_STATUSES = new Set([
  "cancel_requested",
  "outcome_pending",
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
    case "email.unsubscribed":
      return "unsubscribed";
    case "contact.updated":
      return null;
    default:
      return null;
  }
}

export function recipientStatusFromMessageStatus(status: WebhookDerivedStatus): string | null {
  switch (status) {
    case "submitted":
      return "sent";
    case "delivered":
      return "sent";
    case "delayed":
      return "delayed";
    case "bounced":
      return "bounced";
    case "complained":
      return "complained";
    case "suppressed":
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
  const currentRank = MESSAGE_STATUS_RANK[current] ?? 0;
  const nextRank = MESSAGE_STATUS_RANK[next] ?? 0;
  // Allow moving into terminal from any non-terminal.
  if (TERMINAL_MESSAGE_STATUSES.has(next)) return true;
  // Monotonic: never regress (delivered -> submitted is rejected).
  return nextRank >= currentRank;
}

export function canTransitionRecipientStatus(current: string | null | undefined, next: string): boolean {
  if (!current) return true;
  if (current === next) return true;
  if (TERMINAL_RECIPIENT_STATUSES.has(current)) return false;

  // Cancellation-pending rows may be corrected by real delivery outcomes.
  if (CANCELLATION_PENDING_RECIPIENT_STATUSES.has(current)) {
    if (TERMINAL_RECIPIENT_STATUSES.has(next) || next === "sent" || next === "delayed") return true;
    return false;
  }

  const currentRank = RECIPIENT_STATUS_RANK[current] ?? 0;
  const nextRank = RECIPIENT_STATUS_RANK[next] ?? 0;
  if (TERMINAL_RECIPIENT_STATUSES.has(next)) return true;
  return nextRank >= currentRank;
}

/** Statuses that permanently consume daily volume (including unsubscribed). */
export const DAILY_LIMIT_MESSAGE_STATUSES = [
  "captured",
  "submitted",
  "submission_unknown",
  "delivered",
  "delayed",
  "bounced",
  "complained",
  "failed",
  "suppressed",
  "unsubscribed",
] as const;

export function messageStatusRank(status: string): number {
  return MESSAGE_STATUS_RANK[status] ?? 0;
}
