import { z } from "zod";

import { MailboxError } from "./errors.js";

/**
 * Official Spaceship Spacemail client settings:
 * host mail.spacemail.com, IMAP 993 SSL/TLS, SMTP 465 SSL/TLS or 587 STARTTLS.
 * Other hosts and cleartext ports are rejected so credentials are not sent elsewhere.
 */
export const OFFICIAL_MAIL_HOST = "mail.spacemail.com";

const REQUIRED_KEYS = [
  "SPACEMAIL_SMTP_HOST",
  "SPACEMAIL_SMTP_PORT",
  "SPACEMAIL_SMTP_SECURE",
  "SPACEMAIL_IMAP_HOST",
  "SPACEMAIL_IMAP_PORT",
  "SPACEMAIL_IMAP_SECURE",
  "SPACEMAIL_EMAIL",
  "SPACEMAIL_PASSWORD",
  "SPACEMAIL_TEST_RECIPIENT",
] as const;

const emailField = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.email(),
);

const secureField = z.enum(["true", "false"]).transform((value) => value === "true");

const mailEnvSchema = z.object({
  SPACEMAIL_SMTP_HOST: z.string().trim().toLowerCase().min(1),
  SPACEMAIL_SMTP_PORT: z.coerce.number().int().positive(),
  SPACEMAIL_SMTP_SECURE: secureField,
  SPACEMAIL_IMAP_HOST: z.string().trim().toLowerCase().min(1),
  SPACEMAIL_IMAP_PORT: z.coerce.number().int().positive(),
  SPACEMAIL_IMAP_SECURE: secureField,
  SPACEMAIL_EMAIL: emailField,
  SPACEMAIL_PASSWORD: z.string().min(1).refine((value) => !/[\r\n]/.test(value)),
  SPACEMAIL_TEST_RECIPIENT: emailField,
  SPACEMAIL_SENDER_NAME: z.string().optional(),
});

export type MailConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  email: string;
  password: string;
  testRecipient: string;
  senderName: string;
};

export type MailConfigResult =
  | { ok: true; config: MailConfig }
  | { ok: false; reason: "missing" | "invalid" | "host" | "smtp" | "imap" };

function cleanSenderName(value: string | undefined) {
  const cleaned = (value ?? "CTN Slovakia").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  return cleaned || "CTN Slovakia";
}

export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfigResult {
  const missing = REQUIRED_KEYS.some((key) => !(env[key] ?? "").trim());
  if (missing) {
    return { ok: false, reason: "missing" };
  }

  const parsed = mailEnvSchema.safeParse(env);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }

  const data = parsed.data;
  if (data.SPACEMAIL_SMTP_HOST !== OFFICIAL_MAIL_HOST || data.SPACEMAIL_IMAP_HOST !== OFFICIAL_MAIL_HOST) {
    return { ok: false, reason: "host" };
  }

  const smtpOk =
    (data.SPACEMAIL_SMTP_PORT === 465 && data.SPACEMAIL_SMTP_SECURE) ||
    (data.SPACEMAIL_SMTP_PORT === 587 && !data.SPACEMAIL_SMTP_SECURE);
  if (!smtpOk) {
    return { ok: false, reason: "smtp" };
  }

  if (data.SPACEMAIL_IMAP_PORT !== 993 || !data.SPACEMAIL_IMAP_SECURE) {
    return { ok: false, reason: "imap" };
  }

  return {
    ok: true,
    config: {
      smtpHost: data.SPACEMAIL_SMTP_HOST,
      smtpPort: data.SPACEMAIL_SMTP_PORT,
      smtpSecure: data.SPACEMAIL_SMTP_SECURE,
      imapHost: data.SPACEMAIL_IMAP_HOST,
      imapPort: data.SPACEMAIL_IMAP_PORT,
      imapSecure: data.SPACEMAIL_IMAP_SECURE,
      email: data.SPACEMAIL_EMAIL,
      password: data.SPACEMAIL_PASSWORD,
      testRecipient: data.SPACEMAIL_TEST_RECIPIENT,
      senderName: cleanSenderName(data.SPACEMAIL_SENDER_NAME),
    },
  };
}

export function toPublicAccount(config: MailConfig) {
  return {
    accountEmail: config.email,
    testRecipient: config.testRecipient,
    senderName: config.senderName,
  };
}

export function assertAuthorizedParties(
  config: Pick<MailConfig, "email" | "testRecipient">,
  parties: { from: string; to: string },
) {
  const from = parties.from.trim().toLowerCase();
  const to = parties.to.trim().toLowerCase();
  if (from !== config.email || to !== config.testRecipient) {
    throw new MailboxError(
      "Only the configured mailbox can send, and only to the authorized test recipient.",
      400,
      "UNAUTHORIZED_PARTY",
    );
  }
}
