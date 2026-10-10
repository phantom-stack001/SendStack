import { createTransport, type SendMailOptions } from "nodemailer";

import { assertAuthorizedParties, type MailConfig } from "./configuration.js";
import { friendlyMailError, MailboxError, redactSecrets, safeErrorDetails } from "./errors.js";

const MAIL_TIMEOUTS = {
  connectionMs: 15_000,
  greetingMs: 15_000,
  socketMs: 20_000,
} as const;

export type SmtpSubmitResult = {
  accepted: boolean;
  messageId: string;
  acceptedRecipients: string[];
  rejectedRecipients: string[];
  response: string;
};

export type CompiledSubmission = SmtpSubmitResult & { raw: Buffer };

function smtpTransport(config: MailConfig) {
  return createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    requireTLS: !config.smtpSecure,
    auth: {
      user: config.email,
      pass: config.password,
    },
    forceAuth: true,
    connectionTimeout: MAIL_TIMEOUTS.connectionMs,
    greetingTimeout: MAIL_TIMEOUTS.greetingMs,
    socketTimeout: MAIL_TIMEOUTS.socketMs,
    tls: {
      minVersion: "TLSv1.2",
      servername: config.smtpHost,
    },
  });
}

function compileMessage(mail: SendMailOptions) {
  const compiler = createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });
  return compiler
    .sendMail(mail)
    .then((compiled) => {
      if (!Buffer.isBuffer(compiled.message)) {
        throw new MailboxError("The message could not be prepared.", 502, "COMPOSE_FAILED");
      }
      return compiled.message;
    })
    .finally(() => compiler.close());
}

function isUncertainSmtpError(error: unknown) {
  const code = (error as { code?: string }).code ?? "";
  return ["ETIMEDOUT", "ESOCKET", "ECONNECTION", "ECONNRESET", "ETLS", "EDNS"].includes(code);
}

/**
 * Submit one composer message through the configured mailbox.
 * Bcc is on the envelope only, not in the To or Cc headers of the delivered message.
 */
export async function submitComposerMessage(
  config: MailConfig,
  message: {
    subject: string;
    text: string;
    html: string;
    to: string[];
    cc: string[];
    bcc: string[];
    messageId: string;
  },
): Promise<CompiledSubmission> {
  const from = config.email;
  const envelopeTo = [...new Set([...message.to, ...message.cc, ...message.bcc])];
  for (const recipient of envelopeTo) {
    if (recipient !== config.testRecipient) {
      throw new MailboxError(
        "Only the configured mailbox can send, and only to the authorized test recipient.",
        400,
        "UNAUTHORIZED_PARTY",
      );
    }
  }

  const shared = {
    from: { name: config.senderName, address: from },
    to: message.to,
    cc: message.cc.length > 0 ? message.cc : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId: message.messageId,
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  } satisfies SendMailOptions;

  let deliveryRaw: Buffer;
  let sentRaw: Buffer;
  try {
    deliveryRaw = await compileMessage(shared);
    sentRaw = await compileMessage({
      ...shared,
      bcc: message.bcc.length > 0 ? message.bcc : undefined,
    });
  } catch (error) {
    if (error instanceof MailboxError) throw error;
    throw new MailboxError("The message could not be prepared.", 502, "COMPOSE_FAILED");
  }

  const transport = smtpTransport(config);
  try {
    const info = await transport.sendMail({
      envelope: { from, to: envelopeTo },
      raw: deliveryRaw,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const acceptedRecipients = addressList(info.accepted);
    const rejectedRecipients = addressList(info.rejected);
    const accepted =
      rejectedRecipients.length === 0 &&
      envelopeTo.every((recipient) =>
        acceptedRecipients.some((entry) => entry.toLowerCase() === recipient),
      );
    return {
      accepted,
      messageId: message.messageId,
      acceptedRecipients,
      rejectedRecipients,
      response: redactSecrets(info.response ?? "", [config.password]),
      raw: sentRaw,
    };
  } catch (error) {
    const rejected = addressList((error as { rejected?: unknown }).rejected);
    const code = (error as { code?: string }).code;
    if (code === "EENVELOPE" || rejected.length > 0) {
      return {
        accepted: false,
        messageId: message.messageId,
        acceptedRecipients: addressList((error as { accepted?: unknown }).accepted),
        rejectedRecipients: rejected,
        response: redactSecrets(
          error instanceof Error ? error.message : "The outgoing server rejected the message.",
          [config.password],
        ),
        raw: sentRaw,
      };
    }
    console.error("[mail] composer smtp send failed", safeErrorDetails(error, [config.password]));
    if (isUncertainSmtpError(error)) {
      throw new MailboxError(
        "The outgoing server did not confirm whether it accepted the message.",
        502,
        "SMTP_UNCERTAIN",
      );
    }
    throw new MailboxError(friendlyMailError(error, "smtp"), 502, "SMTP_SEND_FAILED");
  } finally {
    transport.close();
  }
}

export async function verifySmtp(config: MailConfig) {
  const transport = smtpTransport(config);
  try {
    await transport.verify();
  } catch (error) {
    console.error("[mail] smtp verify failed", safeErrorDetails(error, [config.password]));
    throw new MailboxError(friendlyMailError(error, "smtp"), 502, "SMTP_VERIFY_FAILED");
  } finally {
    transport.close();
  }
}

function addressList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export async function submitAuthorizedMessage(
  config: MailConfig,
  message: { subject: string; text: string; html: string },
): Promise<CompiledSubmission> {
  assertAuthorizedParties(config, { from: config.email, to: config.testRecipient });

  const domain = config.email.split("@")[1] ?? "localhost";
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const mail: SendMailOptions = {
    from: { name: config.senderName, address: config.email },
    to: config.testRecipient,
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId,
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  };

  const compiler = createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });

  let raw: Buffer;
  try {
    const compiled = await compiler.sendMail(mail);
    if (!Buffer.isBuffer(compiled.message)) {
      throw new MailboxError("The message could not be prepared.", 502, "COMPOSE_FAILED");
    }
    raw = compiled.message;
  } catch (error) {
    if (error instanceof MailboxError) {
      throw error;
    }
    throw new MailboxError("The message could not be prepared.", 502, "COMPOSE_FAILED");
  } finally {
    compiler.close();
  }

  const transport = smtpTransport(config);
  try {
    const info = await transport.sendMail({
      envelope: {
        from: config.email,
        to: config.testRecipient,
      },
      raw,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const acceptedRecipients = addressList(info.accepted);
    const rejectedRecipients = addressList(info.rejected);
    const accepted = acceptedRecipients.some(
      (recipient) => recipient.toLowerCase() === config.testRecipient,
    );
    return {
      accepted: accepted && rejectedRecipients.length === 0,
      messageId,
      acceptedRecipients,
      rejectedRecipients,
      response: redactSecrets(info.response ?? "", [config.password]),
      raw,
    };
  } catch (error) {
    const rejected = addressList((error as { rejected?: unknown }).rejected);
    const code = (error as { code?: string }).code;
    if (code === "EENVELOPE" || rejected.length > 0) {
      return {
        accepted: false,
        messageId,
        acceptedRecipients: addressList((error as { accepted?: unknown }).accepted),
        rejectedRecipients: rejected,
        response: redactSecrets(
          error instanceof Error ? error.message : "The outgoing server rejected the message.",
          [config.password],
        ),
        raw,
      };
    }
    console.error("[mail] smtp send failed", safeErrorDetails(error, [config.password]));
    throw new MailboxError(friendlyMailError(error, "smtp"), 502, "SMTP_SEND_FAILED");
  } finally {
    transport.close();
  }
}
