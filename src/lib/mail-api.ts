export type ConnectionState = "unknown" | "connected" | "failed" | "not_configured";

export type MailFolder = {
  path: string;
  name: string;
  specialUse: string | null;
  selectable: boolean;
  messages: number | null;
};

export type MailMessageSummary = {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  seen: boolean;
  preview: string | null;
};

export type MailPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type MailMessageList = {
  folder: MailFolder;
  folders: MailFolder[];
  messages: MailMessageSummary[];
  pagination: MailPagination;
};

export type MailAttachment = {
  name: string;
  contentType: string;
  size: number;
};

export type MailMessage = {
  uid: number;
  folder: string;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  seen: boolean;
  text: string;
  html: string;
  bodyLimited: boolean;
  attachments: MailAttachment[];
};

export type MailSubmission = {
  id: string;
  status: "pending" | "accepted" | "rejected" | "failed";
  from: string;
  to: string;
  subject: string;
  messageId: string | null;
  smtpAccepted: boolean;
  inboxDeliveryConfirmed: false;
  sentCopyStatus: string | null;
  errorMessage: string | null;
  createdAt: string;
  note: string;
};

export type MailStatus = {
  configured: boolean;
  accountEmail: string | null;
  testRecipient: string | null;
  senderName: string | null;
  outgoing: { status: ConnectionState; error: string | null };
  incoming: { status: ConnectionState; error: string | null };
  lastCheckedAt: string | null;
  latestSubmission: MailSubmission | null;
};

export class MailApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "MailApiError";
    this.status = status;
    this.details = details;
  }
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
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : "Request failed";
    throw new MailApiError(message, response.status, payload);
  }
  return payload as T;
}

export function getMailStatus() {
  return request<MailStatus>("/api/mail/status");
}

export function testMailConnection() {
  return request<MailStatus>("/api/mail/test-connection", { method: "POST" });
}

export function sendMailTest(input: {
  subject: string;
  text: string;
  confirm: true;
  idempotencyKey: string;
}) {
  return request<{ submission: MailSubmission; duplicate: boolean }>("/api/mail/test-send", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listMailFolders() {
  return request<{ folders: MailFolder[] }>("/api/mail/folders");
}

export function listInbox(page: number, limit = 25) {
  return request<MailMessageList>(`/api/mail/inbox?page=${page}&limit=${limit}`);
}

export function listSent(page: number, limit = 25) {
  return request<MailMessageList>(`/api/mail/sent?page=${page}&limit=${limit}`);
}

export function listMailbox(folder: string, page: number, limit = 25) {
  const params = new URLSearchParams({
    folder,
    page: String(page),
    limit: String(limit),
  });
  return request<MailMessageList>(`/api/mail/mailbox?${params.toString()}`);
}

export function getMailMessage(uid: string, folder: string) {
  const params = new URLSearchParams({ folder });
  return request<{ message: MailMessage }>(`/api/mail/messages/${uid}?${params.toString()}`);
}

export function submissionFromError(error: MailApiError) {
  const details = error.details;
  if (!details || typeof details !== "object" || !("submission" in details)) {
    return null;
  }
  return details.submission as MailSubmission;
}
