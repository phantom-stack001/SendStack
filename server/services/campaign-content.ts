import { z } from "zod";

import { processDraftContent } from "../lib/email-content.js";
import type { Database } from "../db/index.js";
import { getEmailDraftById } from "./drafts.js";
import { DRAFT_LIMITS } from "../validation/drafts.js";

export type ContentValidationIssue = { code: string; message: string };

export function validateCampaignContentFields(input: {
  senderName: string;
  senderEmail: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
}): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  if (!input.senderName.trim()) {
    issues.push({ code: "sender_name", message: "Sender name is required" });
  }
  if (!input.senderEmail.trim()) {
    issues.push({ code: "sender_email", message: "Sender email is required" });
  } else if (!z.email().safeParse(input.senderEmail.trim()).success) {
    issues.push({ code: "sender_email", message: "Sender email is invalid" });
  }
  if (!input.subject.trim()) {
    issues.push({ code: "subject", message: "Subject is required" });
  }
  const meaningfulBody =
    input.bodyText.trim().length > 0 ||
    input.bodyHtml.replace(/<[^>]+>/g, "").trim().length > 0;
  if (!meaningfulBody) {
    issues.push({ code: "body", message: "Message body is required" });
  }
  if (!input.bodyText.trim() && meaningfulBody) {
    issues.push({ code: "body_text", message: "Plain-text alternative is missing" });
  }
  if (input.bodyHtml.length > DRAFT_LIMITS.bodyHtmlMaxBytes) {
    issues.push({ code: "body_html", message: "HTML body is too large" });
  }
  return issues;
}

export async function snapshotDraftIntoCampaign(
  db: Database,
  userId: string,
  draftId: string,
) {
  const draft = await getEmailDraftById(db, userId, draftId);
  if (!draft) {
    throw new Error("DRAFT_NOT_FOUND");
  }

  const content = processDraftContent(draft.contentJson);
  if (content.bodyHtml.length > DRAFT_LIMITS.bodyHtmlMaxBytes) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }

  return {
    sourceDraftId: draft.id,
    senderName: draft.senderName,
    senderEmail: draft.senderEmail,
    subject: draft.subject,
    contentJson: content.contentJson,
    bodyHtml: content.bodyHtml,
    bodyText: content.bodyText,
    contentRevision: 1,
  };
}

export function isMeaningfulHtml(html: string) {
  return html.replace(/<[^>]+>/g, "").trim().length > 0;
}
