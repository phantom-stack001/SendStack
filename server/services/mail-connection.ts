import type { Database } from "../db/index.js";
import { loadMailConfig, toPublicAccount } from "../mail/configuration.js";
import { MailboxError } from "../mail/errors.js";
import { verifyImap } from "../mail/imap.js";
import type { ConnectionState, MailStatus } from "../mail/public.js";
import { toPublicSubmission } from "../mail/public.js";
import { verifySmtp } from "../mail/smtp.js";
import { insertConnectionCheck, latestConnectionCheck, latestSubmission } from "./mail-records.js";

const CONNECTION_TEST_INTERVAL_MS = 10_000;
let lastConnectionTestAt = 0;

export async function getMailboxStatus(db: Database): Promise<MailStatus> {
  const loaded = loadMailConfig();
  const [check, submission] = await Promise.all([
    latestConnectionCheck(db),
    latestSubmission(db),
  ]);
  const latest = submission ? toPublicSubmission(submission) : null;

  if (!loaded.ok) {
    console.error("[mail] configuration unavailable", loaded.reason);
    return {
      configured: false,
      accountEmail: null,
      testRecipient: null,
      senderName: null,
      outgoing: { status: "not_configured", error: null },
      incoming: { status: "not_configured", error: null },
      lastCheckedAt: check?.checkedAt.toISOString() ?? null,
      latestSubmission: latest,
    };
  }

  const account = toPublicAccount(loaded.config);
  return {
    configured: true,
    ...account,
    outgoing: {
      status: (check?.smtpStatus as ConnectionState | undefined) ?? "unknown",
      error: check?.smtpError ?? null,
    },
    incoming: {
      status: (check?.imapStatus as ConnectionState | undefined) ?? "unknown",
      error: check?.imapError ?? null,
    },
    lastCheckedAt: check?.checkedAt.toISOString() ?? null,
    latestSubmission: latest,
  };
}

export async function testMailboxConnection(db: Database, userId: string) {
  const loaded = loadMailConfig();
  if (!loaded.ok) {
    console.error("[mail] configuration unavailable", loaded.reason);
    return { kind: "not_configured" as const };
  }

  const now = Date.now();
  if (now - lastConnectionTestAt < CONNECTION_TEST_INTERVAL_MS) {
    return { kind: "rate_limited" as const };
  }
  lastConnectionTestAt = now;

  const config = loaded.config;
  const [smtpResult, imapResult] = await Promise.allSettled([
    verifySmtp(config),
    verifyImap(config),
  ]);

  const smtpError =
    smtpResult.status === "fulfilled"
      ? null
      : smtpResult.reason instanceof MailboxError
        ? smtpResult.reason.message
        : "The outgoing mail server could not complete the request.";
  const imapError =
    imapResult.status === "fulfilled"
      ? null
      : imapResult.reason instanceof MailboxError
        ? imapResult.reason.message
        : "The incoming mail server could not complete the request.";

  await insertConnectionCheck(db, {
    userId,
    smtpStatus: smtpError ? "failed" : "connected",
    imapStatus: imapError ? "failed" : "connected",
    smtpError,
    imapError,
  });

  return { kind: "ok" as const, status: await getMailboxStatus(db) };
}
