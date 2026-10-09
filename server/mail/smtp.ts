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
