export type DeliveryJobStatus =
  | "pending"
  | "queued"
  | "processing"
  | "retry_wait"
  | "simulation_completed"
  | "simulation_failed"
  | "skipped"
  | "cancelled";

export type DeliveryJob = {
  id: string;
  campaignId: string;
  campaignRecipientId: string;
  status: DeliveryJobStatus;
  attemptCount: number;
  maxAttempts: number;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  skipReason: string | null;
  updatedAt: string;
  recipientEmail: string | null;
};

export class QueueApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "QueueApiError";
    this.status = status;
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
    throw new QueueApiError(message, response.status);
  }
  return payload as T;
}

export function fetchQueueOverview() {
  return request<{
    stats: Record<string, number>;
    queueEnabled: boolean;
    simulationOnly: boolean;
  }>("/api/queue/overview");
}

export function fetchQueueJobs(params: {
  page?: number;
  limit?: number;
  status?: DeliveryJobStatus;
  q?: string;
  campaignId?: string;
}) {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.limit) search.set("limit", String(params.limit));
  if (params.status) search.set("status", params.status);
  if (params.q) search.set("q", params.q);
  if (params.campaignId) search.set("campaignId", params.campaignId);
  const qs = search.toString();
  return request<{
    jobs: DeliveryJob[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>(`/api/queue/jobs${qs ? `?${qs}` : ""}`);
}

export function fetchQueueJob(id: string) {
  return request<{ job: DeliveryJob; recipientEmail: string | null; events: unknown[] }>(
    `/api/queue/jobs/${id}`,
  );
}

export function enqueueCampaignSimulation(campaignId: string) {
  return request<{ campaign: unknown; created: number; totalJobs: number; simulationOnly: boolean }>(
    `/api/campaigns/${campaignId}/enqueue`,
    { method: "POST" },
  );
}

export function pauseCampaignQueue(campaignId: string) {
  return request(`/api/campaigns/${campaignId}/pause`, { method: "POST" });
}

export function resumeCampaignQueue(campaignId: string) {
  return request(`/api/campaigns/${campaignId}/resume`, { method: "POST" });
}

export function retryQueueJob(jobId: string) {
  return request(`/api/queue/jobs/${jobId}/retry`, { method: "POST" });
}
