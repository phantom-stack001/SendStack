import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { liveSendAllowed, providerTimeoutMs } from "../live-send";

export type SmtpAttachment = {
  filename: string;
  contentBase64: string;
  contentType: string;
};

export type SmtpEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  unsubscribeUrl?: string;
  attachments?: SmtpAttachment[];
  /** Used as the RFC Message-ID local part when present. */
  messageId?: string;
};

export type SmtpSendResult = {
  id: string;
  accepted: boolean;
};

function loadSmtpConfig(): {
  host: string;
  port: number;
  user: string;
  pass: string;
} {
  const host = (process.env.SENDSTACK_SMTP_HOST ?? "").trim();
  const user = (process.env.SENDSTACK_SMTP_USERNAME ?? "").trim();
  const pass = (process.env.SENDSTACK_SMTP_PASSWORD ?? "").trim();
  const port = Number(process.env.SENDSTACK_SMTP_PORT ?? 465) || 465;
  if (!host || !user || !pass) {
    throw new Error("SMTP is not configured. Set SENDSTACK_SMTP_HOST, SENDSTACK_SMTP_USERNAME, and SENDSTACK_SMTP_PASSWORD.");
  }
  return { host, port, user, pass };
}

/**
 * Send one ordinary MIME message through Spacemail (or any SMTP_SSL relay).
 * Port 465 uses implicit TLS. The message body is not encrypted beyond transit TLS.
 */
export async function sendSmtpEmail(input: SmtpEmailInput): Promise<SmtpSendResult> {
  if (!liveSendAllowed()) {
    throw new Error("SMTP live sending is not enabled.");
  }

  const smtp = loadSmtpConfig();
  const messageId = input.messageId
    ? input.messageId.includes("@")
      ? `<${input.messageId}>`
      : `<${input.messageId}@sendstack.local>`
    : undefined;

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: true,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: providerTimeoutMs(),
    greetingTimeout: providerTimeoutMs(),
    socketTimeout: providerTimeoutMs(),
  } satisfies SMTPTransport.Options);

  try {
    const info = await transport.sendMail({
      from: `${input.fromName} <${input.fromEmail}>`,
      to: input.to,
      replyTo: input.replyTo || undefined,
      subject: input.subject,
      text: input.text || "This message contains an HTML version.",
      html: input.html,
      messageId,
      headers: input.unsubscribeUrl
        ? {
            "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined,
      attachments: input.attachments?.length
        ? input.attachments.map((file) => ({
            filename: file.filename,
            content: Buffer.from(file.contentBase64, "base64"),
            contentType: file.contentType,
          }))
        : undefined,
    });

    const id = (info.messageId || messageId || `smtp:${input.to}`).replace(/^<|>$/g, "");
    return { id, accepted: true };
  } finally {
    transport.close();
  }
}

/**
 * True when the error indicates the SMTP dialogue may have completed after DATA
 * (acceptance ambiguous). Callers must not retry those messages.
 */
export function smtpAcceptanceAmbiguous(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: string }).code ?? "") : "";
  const responseCode =
    "responseCode" in error ? Number((error as { responseCode?: number }).responseCode) : 0;
  // Connection dropped after the server may have accepted; ECONNECTION/ETIMEDOUT mid-send.
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET"].includes(code)) return true;
  // 250 already returned in some nodemailer paths then a later error — rare; treat 2xx as ambiguous on throw.
  if (responseCode >= 200 && responseCode < 300) return true;
  return false;
}
