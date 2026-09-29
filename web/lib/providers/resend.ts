import { config } from "../config";

export type ResendAttachment = {
  filename: string;
  contentBase64: string;
  contentType: string;
};

export type ResendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  unsubscribeUrl?: string;
  attachments?: ResendAttachment[];
  tags?: Array<{ name: string; value: string }>;
  idempotencyKey?: string;
};

function resendHeaders(idempotencyKey?: string): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return headers;
}

function emergencyStopEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.SENDSTACK_EMERGENCY_STOP ?? "").trim().toLowerCase(),
  );
}

export function providerTimeoutMs(): number {
  return Number(process.env.SENDSTACK_PROVIDER_TIMEOUT_MS ?? 8_000) || 8_000;
}

function providerAbortSignal(): AbortSignal {
  return AbortSignal.timeout(providerTimeoutMs());
}

export function liveSendAllowed(): boolean {
  if (config.isVercelPreview) return false;
  if (config.nodeEnv === "test") return false;
  // Checked at the provider chokepoint as well as in the send/launch handlers, so
  // any future provider call path inherits the stop instead of having to repeat it.
  if (emergencyStopEnabled()) return false;
  return Boolean(config.liveSendEnabled && process.env.RESEND_API_KEY);
}

async function resendJson<T extends { id?: string; message?: string; name?: string }>(
  path: string,
  init?: RequestInit & { idempotencyKey?: string },
): Promise<T> {
  if (!liveSendAllowed()) {
    throw new Error("Resend live sending is not enabled.");
  }
  const { idempotencyKey, ...requestInit } = init ?? {};
  const response = await fetch(`https://api.resend.com${path}`, {
    ...requestInit,
    // Without a timeout a hung provider call holds the worker's lease past its
    // expiry, which is exactly the window in which a second worker can claim the
    // same job. It also defeats the tick's time budget under maxDuration.
    signal: providerAbortSignal(),
    headers: {
      ...resendHeaders(idempotencyKey),
      ...(requestInit.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T;
  if (!response.ok) {
    throw new Error(payload.message || payload.name || `Resend request failed (${response.status}).`);
  }
  return payload;
}

export async function sendResendEmail(input: ResendEmailInput): Promise<{ id: string }> {
  const payload = await resendJson<{ id?: string; message?: string; name?: string }>("/emails", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: JSON.stringify({
      from: `${input.fromName} <${input.fromEmail}>`,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      reply_to: input.replyTo || undefined,
      tags: input.tags?.length ? input.tags : undefined,
      headers: input.unsubscribeUrl
        ? {
            "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined,
      attachments: input.attachments?.length
        ? input.attachments.map((file) => ({
            filename: file.filename,
            content: file.contentBase64,
            content_type: file.contentType,
          }))
        : undefined,
    }),
  });
  if (!payload.id) throw new Error("Resend did not return an email id.");
  return { id: payload.id };
}

export async function createResendSegment(name: string): Promise<{ id: string }> {
  const payload = await resendJson<{ id?: string }>("/segments", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!payload.id) throw new Error("Resend did not return a segment id.");
  return { id: payload.id };
}

/**
 * Upsert contact identity fields only. Never forces a subscribed state on the provider
 * so existing opt-out state is preserved.
 */
export async function upsertResendContact(input: {
  email: string;
  firstName?: string;
  lastName?: string;
}): Promise<{ id: string }> {
  const payload = await resendJson<{ id?: string }>("/contacts", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      first_name: input.firstName || undefined,
      last_name: input.lastName || undefined,
    }),
  });
  if (!payload.id) throw new Error(`Resend did not return a contact id for ${input.email}.`);
  return { id: payload.id };
}

export async function addContactToSegment(contactIdOrEmail: string, segmentId: string): Promise<void> {
  await resendJson(`/contacts/${encodeURIComponent(contactIdOrEmail)}/segments/${encodeURIComponent(segmentId)}`, {
    method: "POST",
    body: "{}",
  });
}

export async function createResendBroadcastDraft(input: {
  segmentId: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  name?: string;
}): Promise<{ id: string }> {
  const payload = await resendJson<{ id?: string }>("/broadcasts", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      segment_id: input.segmentId,
      from: `${input.fromName} <${input.fromEmail}>`,
      reply_to: input.replyTo || undefined,
      subject: input.subject,
      html: input.html,
      text: input.text || undefined,
    }),
  });
  if (!payload.id) throw new Error("Resend did not return a broadcast id.");
  return { id: payload.id };
}

export async function sendResendBroadcast(broadcastId: string, idempotencyKey?: string): Promise<{ id: string }> {
  const payload = await resendJson<{ id?: string }>(`/broadcasts/${encodeURIComponent(broadcastId)}/send`, {
    method: "POST",
    idempotencyKey,
    body: "{}",
  });
  return { id: payload.id ?? broadcastId };
}

/** Cancel a queued or scheduled Resend broadcast. Fails if the provider can no longer stop it. */
export async function cancelResendBroadcast(broadcastId: string): Promise<{ id: string }> {
  const payload = await resendJson<{ id?: string }>(`/broadcasts/${encodeURIComponent(broadcastId)}/cancel`, {
    method: "POST",
    body: "{}",
  });
  return { id: payload.id ?? broadcastId };
}

export type ResendBroadcastStatus =
  | "draft"
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "canceled"
  | "cancelled"
  | "failed"
  | string;

/** Retrieve provider broadcast state for ambiguous-submission reconciliation. */
export async function getResendBroadcast(broadcastId: string): Promise<{ id: string; status: ResendBroadcastStatus }> {
  const payload = await resendJson<{ id?: string; status?: string }>(
    `/broadcasts/${encodeURIComponent(broadcastId)}`,
    { method: "GET" },
  );
  return { id: payload.id ?? broadcastId, status: (payload.status ?? "unknown") as ResendBroadcastStatus };
}

/**
 * Bulk contact import into a segment via Resend Contacts Import API.
 * Falls back is handled by the launch worker when this throws.
 */
export async function importResendContactsCsv(input: {
  csv: string;
  segmentId: string;
}): Promise<{ id: string }> {
  if (!liveSendAllowed()) {
    throw new Error("Resend live sending is not enabled.");
  }
  const form = new FormData();
  form.append("file", new Blob([input.csv], { type: "text/csv" }), "contacts.csv");
  form.append(
    "column_map",
    JSON.stringify({ email: "email", first_name: "first_name", last_name: "last_name" }),
  );
  form.append("on_conflict", "upsert");
  form.append("segments", JSON.stringify([{ id: input.segmentId }]));

  const response = await fetch("https://api.resend.com/contacts/imports", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: form,
    // CSV uploads are larger than JSON calls, so allow more time but still bound it.
    signal: AbortSignal.timeout(providerTimeoutMs() * 3),
  });
  const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!response.ok) {
    throw new Error(payload.message || payload.name || `Resend contact import failed (${response.status}).`);
  }
  if (!payload.id) throw new Error("Resend did not return a contact import id.");
  return { id: payload.id };
}

export type ResendContactImportStatus = "pending" | "queued" | "in_progress" | "completed" | "failed" | string;

export type ResendContactImportCounts = {
  total?: number;
  created?: number;
  updated?: number;
  failed?: number;
  [key: string]: number | undefined;
};

/** Poll Resend contact import progress until the worker can decide completed/failed. */
export async function getResendContactImport(
  importId: string,
): Promise<{ id: string; status: ResendContactImportStatus; counts: ResendContactImportCounts }> {
  const payload = await resendJson<{
    id?: string;
    status?: string;
    counts?: ResendContactImportCounts;
  }>(`/contacts/imports/${encodeURIComponent(importId)}`, { method: "GET" });
  return {
    id: payload.id ?? importId,
    status: (payload.status ?? "unknown") as ResendContactImportStatus,
    counts: payload.counts ?? {},
  };
}

/** Convert SendStack {{merge}} tokens to Resend broadcast placeholders. */
export function toResendBroadcastHtml(html: string): string {
  return html
    .replaceAll("{{first_name}}", "{{{contact.first_name|there}}}")
    .replaceAll("{{last_name}}", "{{{contact.last_name}}}")
    .replaceAll("{{email}}", "{{{contact.email}}}")
    .replaceAll("{{unsubscribe_url}}", "{{{RESEND_UNSUBSCRIBE_URL}}}");
}

export function toResendBroadcastText(text: string): string {
  return toResendBroadcastHtml(text);
}

export function buildIdempotencyKey(parts: string[]): string {
  return parts.join(":").slice(0, 256);
}
