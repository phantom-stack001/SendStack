import type { SubscriptionStatus } from "@/lib/recipients-api";

/** User-facing marketing status (two states, SpaceMail-style). */
export type MarketingStatus = "subscribed" | "unsubscribed";

export function isSubscribed(status: SubscriptionStatus): boolean {
  return status === "subscribed";
}

export function marketingStatus(status: SubscriptionStatus): MarketingStatus {
  return isSubscribed(status) ? "subscribed" : "unsubscribed";
}

export function contactStatusLabel(status: SubscriptionStatus): string {
  return isSubscribed(status) ? "Subscribed" : "Unsubscribed";
}

export function contactStatusBadgeVariant(
  status: SubscriptionStatus,
): "default" | "secondary" | "destructive" {
  if (isSubscribed(status)) return "default";
  return "secondary";
}

export const MARKETING_STATUS_OPTIONS: { value: MarketingStatus; label: string }[] = [
  { value: "subscribed", label: "Subscribed" },
  { value: "unsubscribed", label: "Unsubscribed" },
];
