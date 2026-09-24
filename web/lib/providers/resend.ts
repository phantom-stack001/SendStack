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
  unsubscribeUrl?: string;
  attachments?: ResendAttachment[];
};

function resendHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export function liveSendAllowed(): boolean {
  if (config.isVercelPreview) return false;
  return Boolean(config.liveSendEnabled && process.env.RESEND_API_KEY);
}

async function resendJson<T extends { id?: string; message?: string; name?: string }>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!liveSendAllowed()) {
    throw new Error("Resend live sending is not enabled.");
  }
  const response = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      ...resendHeaders(),
      ...(init?.headers ?? {}),
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
    body: JSON.stringify({
      from: `${input.fromName} <${input.fromEmail}>`,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
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
      unsubscribed: false,
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
  subject: string;
  html: string;
  text?: string;
}): Promise<{ id: string }> {
  const payload = await resendJson<{ id?: string }>("/broadcasts", {
    method: "POST",
    body: JSON.stringify({
      segment_id: input.segmentId,
      from: `${input.fromName} <${input.fromEmail}>`,
      subject: input.subject,
      html: input.html,
      text: input.text || undefined,
    }),
  });
  if (!payload.id) throw new Error("Resend did not return a broadcast id.");
  return { id: payload.id };
}

export async function sendResendBroadcast(broadcastId: string): Promise<{ id: string }> {
  const payload = await resendJson<{ id?: string }>(`/broadcasts/${encodeURIComponent(broadcastId)}/send`, {
    method: "POST",
    body: "{}",
  });
  return { id: payload.id ?? broadcastId };
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
