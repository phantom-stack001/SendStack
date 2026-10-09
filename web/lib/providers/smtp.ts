import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { normalizeEmail, validEmail } from "../ids";
import { liveSendAllowed, providerTimeoutMs } from "../live-send";

export type SmtpAttachment = {
  filename: string;
  contentBase64: string;
  contentType: string;
};

export type SmtpEmailInput = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  attachments?: SmtpAttachment[];
};

export type SmtpSendResult = {
  id: string;
  accepted: boolean;
  /** Raw RFC822 used for IMAP Sent append when available. */
  raw?: string;
};

/** Pure Spacemail-client message fields (no socket). */
export type SmtpMailContract = {
  mailbox: string;
  fromHeader: string;
  envelopeFrom: string;
  to: string;
  replyTo?: string;
  html?: string;
  text?: string;
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
 * Build the headers and envelope for one ordinary Spacemail SMTP message.
 * From and envelope sender are always the authenticated mailbox. To is a single address.
 * Message-ID is left for Spacemail to assign. Reply-To only when provided.
 */
export function buildSmtpMailContract(input: {
  mailbox: string;
  to: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  html?: string;
  text?: string;
}): SmtpMailContract {
  const mailbox = normalizeEmail(input.mailbox);
  if (!mailbox || !validEmail(mailbox)) {
    throw new Error("SMTP mailbox username must be a valid email address.");
  }
  const requested = normalizeEmail(input.fromEmail);
  if (requested && requested !== mailbox) {
    throw new Error(`From address must be the Spacemail mailbox (${mailbox}).`);
  }
  const to = input.to.trim();
  if (!to || !validEmail(to)) {
    throw new Error("Recipient must be a valid email address.");
  }
  const fromName = input.fromName.trim() || mailbox;
  if (/[\r\n]/.test(fromName) || /[\r\n]/.test(to)) {
    throw new Error("Email headers cannot contain line breaks.");
  }
  const html = (input.html ?? "").trim() || undefined;
  const text = (input.text ?? "").trim() || undefined;
  if (!html && !text) {
    throw new Error("Message body is required (HTML or plain text).");
  }
  const replyTo = (input.replyTo ?? "").trim() || undefined;
  if (replyTo && (/[\r\n]/.test(replyTo) || !validEmail(replyTo))) {
    throw new Error("Reply-To must be a valid email address.");
  }

  return {
    mailbox,
    fromHeader: `${fromName} <${mailbox}>`,
    envelopeFrom: mailbox,
    to,
    replyTo,
    html,
    text,
  };
}

/**
 * Send one ordinary MIME message through Spacemail (or any SMTP_SSL relay).
 * Port 465 uses implicit TLS. Spacemail assigns Message-ID.
 */
export async function sendSmtpEmail(input: SmtpEmailInput): Promise<SmtpSendResult> {
  if (!liveSendAllowed()) {
    throw new Error("SMTP live sending is not enabled.");
  }

  const smtp = loadSmtpConfig();
  const contract = buildSmtpMailContract({
    mailbox: smtp.user,
    to: input.to,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    replyTo: input.replyTo,
    html: input.html,
    text: input.text,
  });

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
      from: contract.fromHeader,
      to: contract.to,
      envelope: {
        from: contract.envelopeFrom,
        to: contract.to,
      },
      replyTo: contract.replyTo,
      subject: input.subject,
      text: contract.text,
      html: contract.html,
      // Let Spacemail assign Message-ID (same as the webmail client).
      messageId: false as unknown as string,
      attachments: input.attachments?.length
        ? input.attachments.map((file) => ({
            filename: file.filename,
            content: Buffer.from(file.contentBase64, "base64"),
            contentType: file.contentType,
          }))
        : undefined,
    });

    const id = (info.messageId || `smtp:${contract.to}`).replace(/^<|>$/g, "");
    const raw =
      typeof (info as { message?: Buffer | string }).message === "string"
        ? (info as { message: string }).message
        : Buffer.isBuffer((info as { message?: Buffer }).message)
          ? (info as { message: Buffer }).message.toString("utf8")
          : undefined;
    return { id, accepted: true, raw };
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
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET"].includes(code)) return true;
  if (responseCode >= 200 && responseCode < 300) return true;
  return false;
}
