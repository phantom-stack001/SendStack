import type { TiptapDoc } from "@/lib/email-content";

export type Draft = {
  id: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  contentJson: TiptapDoc | null;
  bodyHtml: string;
  bodyText: string;
  createdAt: string;
  updatedAt: string;
};

export type DraftListResponse = {
  drafts: Draft[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export class DraftApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "DraftApiError";
    this.status = status;
    this.details = details;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload.error === "string" ? payload.error : "Request failed";
    throw new DraftApiError(message, response.status, payload);
  }
  return payload as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  return parseResponse<T>(response);
}

export type DraftInput = {
  senderName?: string;
  senderEmail?: string;
  subject?: string;
  contentJson?: TiptapDoc;
};

export function createDraft(input: DraftInput) {
  return request<{ draft: Draft }>("/api/drafts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listDrafts(page = 1, limit = 25) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  return request<DraftListResponse>(`/api/drafts?${params.toString()}`);
}

export function getDraft(id: string) {
  return request<{ draft: Draft }>(`/api/drafts/${id}`);
}

export function updateDraft(id: string, input: DraftInput) {
  return request<{ draft: Draft }>(`/api/drafts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteDraft(id: string) {
  return request<{ ok: boolean }>(`/api/drafts/${id}`, {
    method: "DELETE",
  });
}
