export type ConnectionState = "unknown" | "connected" | "failed" | "not_configured";

export type PublicFolder = {
  path: string;
  name: string;
  specialUse: string | null;
  selectable: boolean;
  /** Total messages from IMAP STATUS. Not an unread count. */
  messages: number | null;
};

export type PublicMessageSummary = {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  seen: boolean;
  preview: string | null;
};

export type MailPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type PublicMessageList = {
  folder: PublicFolder;
  folders: PublicFolder[];
  messages: PublicMessageSummary[];
  pagination: MailPagination;
};

export type PublicAttachment = {
  name: string;
  contentType: string;
  size: number;
};

export type PublicMessage = {
  uid: number;
  folder: string;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  seen: boolean;
  text: string;
  html: string;
  bodyLimited: boolean;
  attachments: PublicAttachment[];
};

export type SubmissionStatus = "pending" | "accepted" | "rejected" | "failed";

export type PublicSubmission = {
  id: string;
  status: SubmissionStatus;
  from: string;
  to: string;
  subject: string;
  messageId: string | null;
  smtpAccepted: boolean;
  inboxDeliveryConfirmed: false;
  sentCopyStatus: string | null;
  errorMessage: string | null;
  createdAt: string;
  note: string;
};

export type MailStatus = {
  configured: boolean;
  accountEmail: string | null;
  testRecipient: string | null;
  senderName: string | null;
  outgoing: { status: ConnectionState; error: string | null };
  incoming: { status: ConnectionState; error: string | null };
  lastCheckedAt: string | null;
  latestSubmission: PublicSubmission | null;
};

const SUBMISSION_STATUSES = new Set<SubmissionStatus>(["pending", "accepted", "rejected", "failed"]);

export function submissionNote(status: SubmissionStatus, sentCopyStatus: string | null) {
  if (status === "accepted") {
    const base =
      "Sent as plain text and HTML. The outgoing server accepted this message for delivery. That does not confirm it reached the recipient inbox.";
    if (sentCopyStatus === "appended") {
      return `${base} A copy was saved in the sent folder.`;
    }
    if (sentCopyStatus === "already_present") {
      return `${base} The sent folder already had this message.`;
    }
    if (sentCopyStatus === "folder_missing") {
      return `${base} No sent folder was available, so a copy was not saved.`;
    }
    if (sentCopyStatus === "failed") {
      return `${base} A sent-folder copy could not be saved.`;
    }
    return base;
  }
  if (status === "rejected") {
    return "The outgoing server rejected the message. It was not accepted for delivery.";
  }
  if (status === "failed") {
    return "The message was not accepted by the outgoing server.";
  }
  return "This test send is still in progress. No additional message should be sent for the same request.";
}

export function toPublicSubmission(row: {
  id: string;
  status: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  messageId: string | null;
  sentCopyStatus: string | null;
  errorMessage: string | null;
  createdAt: Date;
}): PublicSubmission {
  const status = SUBMISSION_STATUSES.has(row.status as SubmissionStatus)
    ? (row.status as SubmissionStatus)
    : "failed";
  return {
    id: row.id,
    status,
    from: row.fromAddress,
    to: row.toAddress,
    subject: row.subject,
    messageId: row.messageId,
    smtpAccepted: status === "accepted",
    inboxDeliveryConfirmed: false,
    sentCopyStatus: row.sentCopyStatus,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    note: submissionNote(status, row.sentCopyStatus),
  };
}
