import { eq } from "drizzle-orm";

import { createDb } from "../db/index.js";
import { user } from "../db/schema.js";
import { loadEnv } from "../env.js";
import { loadMailConfig } from "../mail/configuration.js";
import { MailboxError } from "../mail/errors.js";
import { listMailboxFolders, listMailboxMessages, listSentMessages, verifyImap } from "../mail/imap.js";
import { verifySmtp } from "../mail/smtp.js";
import { sendControlledTest } from "../services/mail-test-send.js";

const env = loadEnv();
const sendRequested = process.argv.includes("--send");

const loaded = loadMailConfig();
if (!loaded.ok) {
  console.error(`Mailbox configuration is unavailable (${loaded.reason}).`);
  process.exit(1);
}

const config = loaded.config;
const summary: Record<string, unknown> = {
  account: config.email,
  testRecipient: config.testRecipient,
  smtp: "unknown",
  imap: "unknown",
};

try {
  await verifySmtp(config);
  summary.smtp = "authenticated";
} catch (error) {
  summary.smtp = error instanceof MailboxError ? error.message : "Outgoing connection failed.";
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

try {
  await verifyImap(config);
  summary.imap = "authenticated";
  const folders = await listMailboxFolders(config);
  summary.folders = folders.map((folder) => folder.name);
  const inbox = await listMailboxMessages(config, "INBOX", 1, 5);
  summary.inboxTotal = inbox.pagination.total;
} catch (error) {
  summary.imap = error instanceof MailboxError ? error.message : "Incoming connection failed.";
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

if (!sendRequested) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const { db, client } = createDb(env);
let exitCode = 2;
try {
  const [admin] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, "super-admin"))
    .limit(1);
  if (!admin) {
    console.error("No super admin account is available.");
    exitCode = 1;
  } else {
    const stamp = new Date().toISOString();
    const subject = `SendStack mailbox test ${stamp}`;
    const outcome = await sendControlledTest(db, admin.id, {
      subject,
      text: "This is one controlled mailbox test from the local SendStack app.",
      idempotencyKey: crypto.randomUUID(),
    });
    summary.send = outcome.kind;
    if ("submission" in outcome) {
      summary.submission = {
        status: outcome.submission.status,
        smtpAccepted: outcome.submission.smtpAccepted,
        inboxDeliveryConfirmed: outcome.submission.inboxDeliveryConfirmed,
        sentCopyStatus: outcome.submission.sentCopyStatus,
        messageId: outcome.submission.messageId,
        note: outcome.submission.note,
      };
    } else if (outcome.kind === "rate_limited") {
      summary.message = outcome.message;
    }

    if (outcome.kind === "accepted") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const inbox = await listMailboxMessages(config, "INBOX", 1, 20);
      summary.inboxHasTest = inbox.messages.some((message) => message.subject === subject);
      try {
        const sent = await listSentMessages(config, 1, 20);
        summary.sentHasTest = sent.messages.some((message) => message.subject === subject);
        summary.sentFolder = sent.folder.path;
      } catch (error) {
        summary.sentFolder = error instanceof MailboxError ? error.message : "Sent folder unavailable.";
      }
      exitCode = 0;
    }
  }
} finally {
  await client.end({ timeout: 5 });
}

console.log(JSON.stringify(summary, null, 2));
process.exit(exitCode);
