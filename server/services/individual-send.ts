import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/index.js";
import { contacts, emailSuppressions } from "../db/schema.js";
import { getEmailDraftById } from "./drafts.js";
import { processDraftContent } from "../lib/email-content.js";
import { normalizeEmail } from "../lib/email-normalization.js";
import type { MailConfig } from "../mail/configuration.js";
import { loadMailConfig } from "../mail/configuration.js";
import {
  assessDirectRecipients,
  assessSender,
  recipientSummary,
  retryDecision,
  type ContactConsent,
} from "../mail/direct-send-policy.js";
import { MailboxError, safeErrorDetails } from "../mail/errors.js";
import { saveSentCopy } from "../mail/imap.js";
import { withPgAdvisoryLock, type MailLock } from "../mail/lock.js";
import { toPublicIndividualSend, type PublicIndividualSend } from "../mail/individual-send-public.js";
import { assessDirectSendRateLimit, DIRECT_SEND_LIMITS } from "../mail/rate-limit.js";
import { submitComposerMessage, type CompiledSubmission } from "../mail/smtp.js";
import {
  findIndividualSubmission,
  insertIndividualSubmission,
  listRecentIndividualSubmissionTimes,
  updateIndividualSubmission,
  type IndividualSubmissionRow,
} from "./individual-send-records.js";

export type IndividualSendInput = {
  senderEmail: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  contentJson: unknown;
  draftId?: string | null;
  idempotencyKey: string;
  confirm: true;
};

export type IndividualSendOutcome =
  | { kind: "not_configured" }
  | { kind: "invalid"; message: string }
  | { kind: "forbidden_draft" }
  | { kind: "rate_limited"; message: string }
  | { kind: "in_progress"; submission: PublicIndividualSend }
  | { kind: "duplicate"; submission: PublicIndividualSend }
  | { kind: "accepted"; submission: PublicIndividualSend }
  | { kind: "rejected"; submission: PublicIndividualSend }
  | { kind: "failed"; submission: PublicIndividualSend }
  | { kind: "uncertain"; submission: PublicIndividualSend };

type Submit = (
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
) => Promise<CompiledSubmission>;

function messageIdFor(email: string) {
  const domain = email.split("@")[1] ?? "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}

async function loadEligibility(db: Database, userId: string, emails: string[]) {
  if (emails.length === 0) {
    return { contactsByEmail: new Map<string, ContactConsent>(), suppressed: new Set<string>() };
  }
  const [contactRows, suppressionRows] = await Promise.all([
    db
      .select({ email: contacts.email, subscriptionStatus: contacts.subscriptionStatus })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.email, emails))),
    db
      .select({ email: emailSuppressions.email })
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.userId, userId), inArray(emailSuppressions.email, emails))),
  ]);
  const contactsByEmail = new Map<string, ContactConsent>();
  for (const row of contactRows) {
    contactsByEmail.set(row.email, {
      subscriptionStatus: row.subscriptionStatus as ContactConsent["subscriptionStatus"],
    });
  }
  return {
    contactsByEmail,
    suppressed: new Set(suppressionRows.map((row) => row.email)),
  };
}

function publicOf(row: IndividualSubmissionRow) {
  return toPublicIndividualSend(row);
}

export async function sendIndividualEmail(
  db: Database,
  userId: string,
  input: IndividualSendInput,
  deps?: { submit?: Submit },
): Promise<IndividualSendOutcome> {
  const loaded = loadMailConfig();
  if (!loaded.ok) return { kind: "not_configured" };
  const config = loaded.config;
  const submit = deps?.submit ?? submitComposerMessage;

  const sender = assessSender(input.senderEmail, config.email);
  if (!sender.ok) return { kind: "invalid", message: sender.message };

  if (input.draftId) {
    const draft = await getEmailDraftById(db, userId, input.draftId);
    if (!draft) return { kind: "forbidden_draft" };
    const draftSender = assessSender(draft.senderEmail, config.email);
    if (!draftSender.ok) return { kind: "invalid", message: draftSender.message };
  }

  const content = processDraftContent(input.contentJson);
  if (!content.bodyText) {
    return { kind: "invalid", message: "Write a message before sending." };
  }

  const provisional = assessDirectRecipients({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    allowlist: [config.testRecipient],
    contactsByEmail: new Map(),
    suppressed: new Set(),
  });
  if (!provisional.ok) return { kind: "invalid", message: provisional.message };

  const emails = [...provisional.to, ...provisional.cc, ...provisional.bcc];
  const eligibility = await loadEligibility(db, userId, emails);
  const recipients = assessDirectRecipients({
    to: provisional.to,
    cc: provisional.cc,
    bcc: provisional.bcc,
    allowlist: [normalizeEmail(config.testRecipient)],
    contactsByEmail: eligibility.contactsByEmail,
    suppressed: eligibility.suppressed,
  });
  if (!recipients.ok) return { kind: "invalid", message: recipients.message };

  const lock: MailLock = (task) =>
    withPgAdvisoryLock(db, `individual-send:${input.idempotencyKey}`, task);
  const sentCopyLock = (messageId: string): MailLock => (task) =>
    withPgAdvisoryLock(db, `sent-copy:${messageId}`, task);

  return lock(async () => {
    const existing = await findIndividualSubmission(db, input.idempotencyKey);
    if (existing) {
      if (existing.userId !== userId) return { kind: "forbidden_draft" };
      const decision = retryDecision(existing.status);
      if (decision === "uncertain") {
        const row =
          existing.status === "submitting"
            ? await updateIndividualSubmission(db, existing.id, {
                status: "uncertain",
                errorCode: "SMTP_UNCERTAIN",
                errorMessage: "The previous submission did not confirm an outcome.",
              })
            : existing;
        return { kind: "uncertain", submission: publicOf(row ?? existing) };
      }
      if (decision === "replay") {
        return { kind: "duplicate", submission: publicOf(existing) };
      }
      const samePayload =
        existing.subject === input.subject &&
        existing.toRecipients.join("\n") === recipients.to.join("\n") &&
        existing.ccRecipients.join("\n") === recipients.cc.join("\n") &&
        existing.bccRecipients.join("\n") === recipients.bcc.join("\n");
      if (!samePayload) {
        return {
          kind: "invalid",
          message: "This send request no longer matches the original submission.",
        };
      }
    }

    let row = existing;
    if (!row) {
      const recent = await listRecentIndividualSubmissionTimes(
        db,
        userId,
        new Date(Date.now() - DIRECT_SEND_LIMITS.hourMs),
      );
      const limit = assessDirectSendRateLimit(recent, new Date());
      if (!limit.allowed) return { kind: "rate_limited", message: limit.message };
      row = await insertIndividualSubmission(db, {
        userId,
        sourceDraftId: input.draftId ?? null,
        idempotencyKey: input.idempotencyKey,
        senderEmail: config.email,
        toRecipients: recipients.to,
        ccRecipients: recipients.cc,
        bccRecipients: recipients.bcc,
        recipientSummary: recipientSummary(recipients.to),
        subject: input.subject,
      });
      if (!row) {
        const raced = await findIndividualSubmission(db, input.idempotencyKey);
        if (raced) return { kind: "duplicate", submission: publicOf(raced) };
        return { kind: "invalid", message: "The submission could not be recorded." };
      }
    }

    const messageId = row.messageId ?? messageIdFor(config.email);
    const submitting = await updateIndividualSubmission(db, row.id, {
      status: "submitting",
      messageId,
      errorCode: null,
      errorMessage: null,
    });
    const active = submitting ?? { ...row, status: "submitting" as const, messageId };

    try {
      const submitted = await submit(config, {
        subject: input.subject,
        text: content.bodyText,
        html: content.bodyHtml,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        messageId,
      });
      if (!submitted.accepted) {
        const saved = await updateIndividualSubmission(db, active.id, {
          status: "rejected",
          messageId,
          sentCopyStatus: "not_attempted",
          errorCode: "SMTP_REJECTED",
          errorMessage: "The outgoing mail server rejected the message.",
        });
        return { kind: "rejected", submission: publicOf(saved ?? { ...active, status: "rejected" }) };
      }

      const sentCopy = await saveSentCopy(config, submitted.raw, messageId, sentCopyLock(messageId));
      const saved = await updateIndividualSubmission(db, active.id, {
        status: "accepted",
        messageId,
        smtpAcceptedAt: new Date(),
        sentCopyStatus: sentCopy.status,
        sentCopySavedAt: sentCopy.status === "appended" || sentCopy.status === "already_present" ? new Date() : null,
        errorCode: sentCopy.status === "failed" ? "SENT_COPY_FAILED" : null,
        errorMessage: sentCopy.errorMessage,
      });
      return {
        kind: "accepted",
        submission: publicOf(
          saved ?? {
            ...active,
            status: "accepted",
            sentCopyStatus: sentCopy.status,
            errorMessage: sentCopy.errorMessage,
          },
        ),
      };
    } catch (error) {
      const uncertain = error instanceof MailboxError && error.code === "SMTP_UNCERTAIN";
      const message =
        error instanceof MailboxError
          ? error.message
          : "The outgoing mail server could not complete the request.";
      console.error("[mail] individual send failed", safeErrorDetails(error, [config.password]));
      const status = uncertain ? "uncertain" : "failed";
      const saved = await updateIndividualSubmission(db, active.id, {
        status,
        messageId,
        sentCopyStatus: "not_attempted",
        errorCode: error instanceof MailboxError ? error.code : "SMTP_SEND_FAILED",
        errorMessage: message,
      });
      return {
        kind: status,
        submission: publicOf(saved ?? { ...active, status, errorMessage: message }),
      };
    }
  });
}
