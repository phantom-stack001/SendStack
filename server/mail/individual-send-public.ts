import type { StoredSendStatus } from "./direct-send-policy.js";

export type PublicIndividualSend = {
  id: string;
  status: StoredSendStatus;
  from: string;
  to: string[];
  cc: string[];
  bccCount: number;
  bcc: string[];
  subject: string;
  messageId: string | null;
  smtpAccepted: boolean;
  inboxDeliveryConfirmed: false;
  sentCopyStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  note: string;
};

const STATUSES = new Set<StoredSendStatus>([
  "pending",
  "submitting",
  "accepted",
  "rejected",
  "failed",
  "uncertain",
]);

export function individualSendNote(status: StoredSendStatus, sentCopyStatus: string | null) {
  if (status === "accepted") {
    const base =
      "Email accepted by the outgoing mail server. That does not confirm it reached the recipient inbox.";
    if (sentCopyStatus === "appended" || sentCopyStatus === "already_present") {
      return `${base} A copy is in the sent folder.`;
    }
    if (sentCopyStatus === "failed" || sentCopyStatus === "folder_missing") {
      return `${base} The sent-folder copy was not saved.`;
    }
    return base;
  }
  if (status === "rejected") {
    return "The outgoing mail server rejected the message.";
  }
  if (status === "uncertain" || status === "submitting") {
    return "The outcome is uncertain. This request was not submitted again.";
  }
  if (status === "failed") {
    return "The message was not accepted by the outgoing mail server.";
  }
  return "This submission is still being prepared.";
}

export function toPublicIndividualSend(row: {
  id: string;
  status: string;
  senderEmail: string;
  toRecipients: string[];
  ccRecipients: string[];
  bccRecipients: string[];
  subject: string;
  messageId: string | null;
  sentCopyStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}): PublicIndividualSend {
  const status = STATUSES.has(row.status as StoredSendStatus)
    ? (row.status as StoredSendStatus)
    : "uncertain";
  return {
    id: row.id,
    status,
    from: row.senderEmail,
    to: row.toRecipients,
    cc: row.ccRecipients,
    bccCount: row.bccRecipients.length,
    bcc: row.bccRecipients,
    subject: row.subject,
    messageId: row.messageId,
    smtpAccepted: status === "accepted",
    inboxDeliveryConfirmed: false,
    sentCopyStatus: row.sentCopyStatus,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    note: individualSendNote(status, row.sentCopyStatus),
  };
}
