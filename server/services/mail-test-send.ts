import type { Database } from "../db/index.js";
import { loadMailConfig } from "../mail/configuration.js";
import { MailboxError, safeErrorDetails } from "../mail/errors.js";
import { plainTextToSafeHtml, sanitizeInboundHtml } from "../mail/html.js";
import { performIdempotentSend } from "../mail/idempotency.js";
import { saveSentCopy } from "../mail/imap.js";
import { withPgAdvisoryLock, type MailLock } from "../mail/lock.js";
import { toPublicSubmission, type PublicSubmission } from "../mail/public.js";
import { assessTestSendRateLimit, TEST_SEND_LIMITS } from "../mail/rate-limit.js";
import { submitAuthorizedMessage } from "../mail/smtp.js";
import {
  expireStalePendingSubmissions,
  findSubmissionByKey,
  insertPendingSubmission,
  listRecentSubmissionTimes,
  updateSubmission,
} from "./mail-records.js";


export type TestSendInput = {
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
};

export type TestSendOutcome =
  | { kind: "not_configured" }
  | { kind: "in_progress" }
  | { kind: "duplicate"; submission: PublicSubmission }
  | { kind: "rate_limited"; message: string }
  | { kind: "accepted"; submission: PublicSubmission }
  | { kind: "rejected"; submission: PublicSubmission }
  | { kind: "failed"; submission: PublicSubmission };

function prepareHtml(input: TestSendInput) {
  if (!input.html?.trim()) {
    return plainTextToSafeHtml(input.text);
  }
  const safe = sanitizeInboundHtml(input.html);
  if (!safe) {
    throw new MailboxError(
      "The HTML version of this message is empty after sanitizing.",
      400,
      "HTML_EMPTY",
    );
  }
  return safe;
}

function outcomeFromRow(row: {
  id: string;
  status: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  messageId: string | null;
  sentCopyStatus: string | null;
  errorMessage: string | null;
  createdAt: Date;
}): TestSendOutcome {
  const submission = toPublicSubmission(row);
  if (submission.status === "pending") {
    return { kind: "in_progress" };
  }
  if (submission.status === "accepted") {
    return { kind: "duplicate", submission };
  }
  if (submission.status === "rejected") {
    return { kind: "duplicate", submission };
  }
  return { kind: "duplicate", submission };
}

function fallbackRow(
  pending: {
    id: string;
    status: string;
    fromAddress: string;
    toAddress: string;
    subject: string;
    messageId: string | null;
    sentCopyStatus: string | null;
    errorMessage: string | null;
    createdAt: Date;
  },
  patch: {
    status: string;
    messageId?: string | null;
    sentCopyStatus?: string | null;
    errorMessage?: string | null;
  },
) {
  return {
    ...pending,
    status: patch.status,
    messageId: patch.messageId ?? pending.messageId,
    sentCopyStatus: patch.sentCopyStatus ?? pending.sentCopyStatus,
    errorMessage: patch.errorMessage ?? pending.errorMessage,
  };
}

export async function sendControlledTest(
  db: Database,
  userId: string,
  input: TestSendInput,
): Promise<TestSendOutcome> {
  const loaded = loadMailConfig();
  if (!loaded.ok) {
    console.error("[mail] configuration unavailable", loaded.reason);
    return { kind: "not_configured" };
  }

  const lock: MailLock = (task) => withPgAdvisoryLock(db, `mail-test:${input.idempotencyKey}`, task);
  const sentCopyLock = (messageId: string): MailLock =>
    (task) => withPgAdvisoryLock(db, `sent-copy:${messageId}`, task);

  const config = loaded.config;
  const outcome = await performIdempotentSend({
    lock,
    find: () => findSubmissionByKey(db, input.idempotencyKey),
    prepare: () => expireStalePendingSubmissions(db),
    gate: async () => {
      const now = new Date();
      const recent = await listRecentSubmissionTimes(
        db,
        new Date(now.getTime() - TEST_SEND_LIMITS.hourMs),
      );
      const limit = assessTestSendRateLimit(recent, now);
      return limit.allowed ? null : limit.message;
    },
    insert: () =>
      insertPendingSubmission(db, {
        userId,
        idempotencyKey: input.idempotencyKey,
        fromAddress: config.email,
        toAddress: config.testRecipient,
        subject: input.subject,
      }),
    send: async (pending) => {
      try {
        const html = prepareHtml(input);
        const submitted = await submitAuthorizedMessage(config, {
          subject: input.subject,
          text: input.text,
          html,
        });

        if (!submitted.accepted) {
          const failed = await updateSubmission(db, pending.id, {
            status: "rejected",
            messageId: submitted.messageId,
            smtpResponse: submitted.response,
            acceptedRecipients: submitted.acceptedRecipients,
            rejectedRecipients: submitted.rejectedRecipients,
            sentCopyStatus: "not_attempted",
            errorMessage: "The outgoing server rejected the message.",
          });
          return {
            kind: "rejected" as const,
            submission: toPublicSubmission(
              failed ??
                fallbackRow(pending, {
                  status: "rejected",
                  messageId: submitted.messageId,
                  sentCopyStatus: "not_attempted",
                  errorMessage: "The outgoing server rejected the message.",
                }),
            ),
          };
        }

        const sentCopy = await saveSentCopy(
          config,
          submitted.raw,
          submitted.messageId,
          sentCopyLock(submitted.messageId),
        );
        const saved = await updateSubmission(db, pending.id, {
          status: "accepted",
          messageId: submitted.messageId,
          smtpResponse: submitted.response,
          acceptedRecipients: submitted.acceptedRecipients,
          rejectedRecipients: submitted.rejectedRecipients,
          sentCopyStatus: sentCopy.status,
          sentCopyError: sentCopy.errorMessage,
          errorMessage: sentCopy.errorMessage,
        });
        return {
          kind: "accepted" as const,
          submission: toPublicSubmission(
            saved ??
              fallbackRow(pending, {
                status: "accepted",
                messageId: submitted.messageId,
                sentCopyStatus: sentCopy.status,
                errorMessage: sentCopy.errorMessage,
              }),
          ),
        };
      } catch (error) {
        const message =
          error instanceof MailboxError
            ? error.message
            : "The outgoing mail server could not complete the request.";
        console.error("[mail] test send failed", safeErrorDetails(error, [config.password]));
        const failed = await updateSubmission(db, pending.id, {
          status: "failed",
          sentCopyStatus: "not_attempted",
          errorMessage: message,
        });
        return {
          kind: "failed" as const,
          submission: toPublicSubmission(
            failed ??
              fallbackRow(pending, {
                status: "failed",
                messageId: null,
                sentCopyStatus: "not_attempted",
                errorMessage: message,
              }),
          ),
        };
      }
    },
  });

  if (outcome.type === "blocked") {
    return { kind: "rate_limited", message: outcome.message };
  }
  if (outcome.type === "busy") {
    return { kind: "in_progress" };
  }
  if (outcome.type === "replay") {
    return outcomeFromRow(outcome.row);
  }
  return outcome.value;
}
