import type { TiptapDoc } from "@/lib/email-content";

export type CampaignStatus =
  | "draft"
  | "ready"
  | "scheduled"
  | "queued"
  | "processing"
  | "paused"
  | "simulation_completed"
  | "simulation_failed"
  | "sending"
  | "completed"
  | "failed"
  | "cancelled";

export type Campaign = {
  id: string;
  name: string;
  description: string;
  status: CampaignStatus;
  sourceDraftId: string | null;
  senderName: string;
  senderEmail: string;
  subject: string;
  contentJson: TiptapDoc | Record<string, unknown> | null;
  bodyHtml: string;
  bodyText: string;
  contentRevision: number;
  revision: number;
  scheduledAt: string | null;
  scheduleTimezone: string | null;
  eligibleRecipientCount: number;
  queuePaused: boolean;
  queueGeneration: number;
  enqueuedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignRecipientSource = {
  id: string;
  sourceType: "individual_contact" | "contact_list";
  contactId: string | null;
  contactListId: string | null;
  createdAt: string;
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

export type CampaignEvent = {
  id: string;
  campaignId: string;
  actorUserId: string;
  eventType: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export class CampaignApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "CampaignApiError";
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : "Request failed";
    throw new CampaignApiError(message, response.status, payload);
  }
  return payload as T;
}

export function fetchCampaignStats() {
  return request<{ stats: { total: number; draft: number; ready: number; scheduled: number; cancelled: number } }>(
    "/api/campaigns/stats",
  );
}

export function fetchCampaigns(params: { page?: number; limit?: number; q?: string; status?: CampaignStatus }) {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.limit) search.set("limit", String(params.limit));
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  const qs = search.toString();
  return request<{
    campaigns: Campaign[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>(`/api/campaigns${qs ? `?${qs}` : ""}`);
}

export function createCampaign(input?: { name?: string; description?: string }) {
  return request<{ campaign: Campaign }>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export function fetchCampaign(id: string) {
  return request<{
    campaign: Campaign;
    recipientSources: CampaignRecipientSource[];
    events: CampaignEvent[];
    snapshotEligibleCount: number;
  }>(`/api/campaigns/${id}`);
}

export function updateCampaign(
  id: string,
  input: {
    expectedRevision: number;
    name?: string;
    description?: string;
    sourceDraftId?: string | null;
    recipientSources?: { contactIds?: string[]; contactListIds?: string[] };
    scheduledAt?: string | null;
    scheduleTimezone?: string | null;
    revertToDraft?: boolean;
  },
) {
  return request<{ campaign: Campaign }>(`/api/campaigns/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteCampaign(id: string) {
  return request<{ ok: boolean }>(`/api/campaigns/${id}`, { method: "DELETE" });
}

export function duplicateCampaign(id: string) {
  return request<{ campaign: Campaign }>(`/api/campaigns/${id}/duplicate`, { method: "POST" });
}

export function validateCampaign(id: string) {
  return request<{
    contentIssues: { code: string; message: string }[];
    eligibility: EligibilitySummary;
    canMarkReady: boolean;
  }>(`/api/campaigns/${id}/validate`, { method: "POST" });
}

export function prepareCampaign(id: string, markReady = false) {
  return request<{
    campaign: Campaign;
    contentIssues: { code: string; message: string }[];
    eligibility: EligibilitySummary;
  }>(`/api/campaigns/${id}/prepare`, {
    method: "POST",
    body: JSON.stringify({ markReady }),
  });
}

export function cancelCampaign(id: string) {
  return request<{ campaign: Campaign }>(`/api/campaigns/${id}/cancel`, { method: "POST" });
}
