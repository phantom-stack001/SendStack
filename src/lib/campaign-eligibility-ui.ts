type SubscriptionStatus = "subscribed" | "unsubscribed" | "pending" | "unknown";

export type EligibilitySummaryCounts = {
  selectedRaw: number;
  uniqueEmails: number;
  duplicates: number;
  eligible: number;
  excludedUnsubscribed: number;
  excludedSuppressed: number;
  excludedPendingConsent?: number;
  excludedUnknownConsent: number;
  excludedInvalid: number;
  excludedTotal: number;
};

export type EligibilityExclusionStatus =
  | "excluded_unsubscribed"
  | "excluded_suppressed"
  | "excluded_pending_consent"
  | "excluded_unknown_consent"
  | "excluded_invalid";

export type RecipientDisplayStatus =
  | "subscribed"
  | "unsubscribed"
  | "pending"
  | "unknown"
  | "suppressed";

export function recipientDisplayStatus(
  subscriptionStatus: SubscriptionStatus,
  emailSuppressed: boolean,
): RecipientDisplayStatus {
  if (emailSuppressed) return "suppressed";
  if (subscriptionStatus === "subscribed") return "subscribed";
  if (subscriptionStatus === "pending") return "pending";
  if (subscriptionStatus === "unknown") return "unknown";
  return "unsubscribed";
}

export const RECIPIENT_STATUS_LABELS: Record<RecipientDisplayStatus, string> = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  pending: "Pending",
  unknown: "Unknown",
  suppressed: "Suppressed",
};

export const RECIPIENT_STATUS_HELP: Record<RecipientDisplayStatus, string> = {
  subscribed: "Recorded permission exists.",
  unsubscribed: "This contact has unsubscribed and is not eligible for campaign delivery.",
  pending: "Permission has not been confirmed.",
  unknown: "No sufficient permission record is available.",
  suppressed: "This address is blocked from delivery.",
};

export function exclusionStatusLabel(status: EligibilityExclusionStatus): string {
  switch (status) {
    case "excluded_unsubscribed":
      return "Unsubscribed";
    case "excluded_suppressed":
      return "Suppressed";
    case "excluded_pending_consent":
      return "Pending consent";
    case "excluded_unknown_consent":
      return "Unknown consent";
    case "excluded_invalid":
      return "Invalid email";
    default:
      return "Excluded";
  }
}

export function exclusionCategoryRows(summary: EligibilitySummaryCounts) {
  return [
    { key: "unsubscribed", label: "Unsubscribed", count: summary.excludedUnsubscribed },
    { key: "suppressed", label: "Suppressed", count: summary.excludedSuppressed },
    { key: "pending", label: "Pending consent", count: summary.excludedPendingConsent ?? 0 },
    { key: "unknown", label: "Unknown consent", count: summary.excludedUnknownConsent },
    { key: "invalid", label: "Invalid email", count: summary.excludedInvalid },
  ].filter((row) => row.count > 0);
}

export function wizardStepForIssueCode(code: string): number {
  if (
    code.startsWith("CONTENT_") ||
    code.startsWith("SENDER_") ||
    code === "DRAFT_REQUIRED"
  ) {
    return 1;
  }
  if (
    code === "NO_ELIGIBLE_RECIPIENTS" ||
    code === "NO_RECIPIENT_SOURCES" ||
    code.startsWith("RECIPIENT_")
  ) {
    return 2;
  }
  if (code === "NAME_REQUIRED") return 0;
  return 4;
}
