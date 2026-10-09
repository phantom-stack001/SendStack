import { createRequire } from "node:module";

import { ImapFlow, type FetchMessageObject, type ListResponse } from "imapflow";

import type { MailConfig } from "./configuration.js";
import { friendlyMailError, MailboxError, safeErrorDetails } from "./errors.js";
import { sanitizeInboundHtml } from "./html.js";
import { messagePageRange } from "./pagination.js";
import { previewFromPart } from "./preview.js";
import type {
  PublicAttachment,
  PublicFolder,
  PublicMessage,
  PublicMessageList,
  PublicMessageSummary,
} from "./public.js";
import { appendIfMessageMissing } from "./sent-copy.js";
import { findSentMailbox } from "./sent-folder.js";
import type { MailLock } from "./lock.js";

const require = createRequire(import.meta.url);

type ParsedMail = {
  text?: string;
  html?: string | false;
  attachments?: Array<{
    filename?: string;
    contentType?: string;
    size?: number;
  }>;
};

const { simpleParser } = require("mailparser") as {
  simpleParser: (source: Buffer) => Promise<ParsedMail>;
};

const MAIL_TIMEOUTS = {
  connectionMs: 15_000,
  greetingMs: 15_000,
  socketMs: 25_000,
} as const;

const MAX_MESSAGE_BYTES = 2_000_000;
const MAX_HTML_CHARS = 200_000;
const MAX_TEXT_CHARS = 100_000;
const SENT_COPY_RETRY_MS = 500;

function createClient(config: MailConfig) {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.email,
      pass: config.password,
    },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: MAIL_TIMEOUTS.connectionMs,
    greetingTimeout: MAIL_TIMEOUTS.greetingMs,
    socketTimeout: MAIL_TIMEOUTS.socketMs,
    tls: {
      minVersion: "TLSv1.2",
      servername: config.imapHost,
    },
    clientInfo: {
      name: "SendStack",
      version: "0.1.0",
    },
  });
  client.on("error", () => {
    // Callers log the thrown error. This avoids an unhandled EventEmitter error.
  });
  return client;
}

async function withImap<T>(config: MailConfig, task: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = createClient(config);
  try {
    await client.connect();
    return await task(client);
  } catch (error) {
    if (error instanceof MailboxError) {
      throw error;
    }
    console.error("[mail] imap", safeErrorDetails(error, [config.password]));
    throw new MailboxError(friendlyMailError(error, "imap"), 502, "IMAP_FAILED");
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

function mapFolders(list: ListResponse[]): PublicFolder[] {
  const folders = list.slice(0, 200).map((box) => ({
    path: box.path,
    name: box.name || box.path,
    specialUse: box.specialUse ?? null,
    selectable: !box.flags?.has("\\Noselect"),
    messages: typeof box.status?.messages === "number" ? box.status.messages : null,
  }));
  folders.sort((left, right) => {
    if (left.path.toUpperCase() === "INBOX") return -1;
    if (right.path.toUpperCase() === "INBOX") return 1;
    return left.name.localeCompare(right.name);
  });
  return folders;
}

function resolveFolder(folders: PublicFolder[], requested: string) {
  return (
    folders.find((folder) => folder.path === requested) ??
    (requested.toUpperCase() === "INBOX"
      ? folders.find((folder) => folder.path.toUpperCase() === "INBOX")
      : undefined)
  );
}

function collapseHeader(value: string | undefined, fallback: string) {
  const cleaned = (value ?? "").replace(/[\r\n]+/g, " ").trim();
  return (cleaned || fallback).slice(0, 500);
}

function formatAddresses(entries: { name?: string; address?: string }[] | undefined, fallback: string) {
  if (!entries?.length) {
    return fallback;
  }
  return entries
    .map((entry) => {
      const address = entry.address?.trim();
      const name = entry.name?.replace(/[\r\n]+/g, " ").trim();
      if (name && address) return `${name} <${address}>`;
      return address || name || fallback;
    })
    .join(", ")
    .slice(0, 500);
}

function toIso(value: Date | string | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function summarize(message: FetchMessageObject): PublicMessageSummary {
  return {
    uid: message.uid,
    subject: collapseHeader(message.envelope?.subject, "(No subject)"),
    from: formatAddresses(message.envelope?.from, "Unknown sender"),
    to: formatAddresses(message.envelope?.to, "Unknown recipient"),
    date: toIso(message.envelope?.date ?? message.internalDate),
    seen: message.flags?.has("\\Seen") ?? false,
    preview: previewFromPart(
      message.bodyParts?.get("1") ?? message.bodyParts?.get("text") ?? message.bodyParts?.get("TEXT"),
    ),
  };
}

async function loadFolders(client: ImapFlow) {
  try {
    return mapFolders(await client.list({ statusQuery: { messages: true } }));
  } catch (error) {
    console.error("[mail] folder status", safeErrorDetails(error, []));
    return mapFolders(await client.list());
  }
}

async function readFolderPage(
  client: ImapFlow,
  folders: PublicFolder[],
  folder: PublicFolder,
  page: number,
  limit: number,
): Promise<PublicMessageList> {
  const lock = await client.getMailboxLock(folder.path);
  try {
    const mailbox = client.mailbox;
    const total = mailbox && typeof mailbox === "object" ? mailbox.exists : 0;
    const range = messagePageRange(total, page, limit);
    const collected: PublicMessageSummary[] = [];
    if (range) {
      const query = {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        bodyParts: [{ key: "1", start: 0, maxLength: 1200 }],
      };
      try {
        for await (const message of client.fetch(`${range.start}:${range.end}`, query)) {
          collected.push(summarize(message));
        }
      } catch (error) {
        console.error("[mail] message preview", safeErrorDetails(error, []));
        collected.length = 0;
        for await (const message of client.fetch(`${range.start}:${range.end}`, {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
        })) {
          collected.push(summarize(message));
        }
      }
    }
    const counted =
      folder.messages === null ? { ...folder, messages: total } : folder;
    return {
      folder: counted,
      folders: folders.map((entry) => (entry.path === counted.path ? counted : entry)),
      messages: collected.reverse(),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 1 : Math.ceil(total / limit),
      },
    };
  } finally {
    lock.release();
  }
}

export async function verifyImap(config: MailConfig) {
  await withImap(config, async (client) => {
    await client.list();
  });
}

export async function listMailboxFolders(config: MailConfig) {
  return withImap(config, async (client) => loadFolders(client));
}

export async function listMailboxMessages(
  config: MailConfig,
  requestedFolder: string,
  page: number,
  limit: number,
) {
  return withImap(config, async (client) => {
    const folders = await loadFolders(client);
    const folder = resolveFolder(folders, requestedFolder);
    if (!folder?.selectable) {
      throw new MailboxError("That mailbox folder is not available.", 404, "FOLDER_MISSING");
    }
    return readFolderPage(client, folders, folder, page, limit);
  });
}

export async function listSentMessages(config: MailConfig, page: number, limit: number) {
  return withImap(config, async (client) => {
    const folders = await loadFolders(client);
    const sent = findSentMailbox(folders);
    if (!sent?.selectable) {
      throw new MailboxError("The sent folder is not available on this mailbox.", 404, "SENT_FOLDER_MISSING");
    }
    return readFolderPage(client, folders, sent, page, limit);
  });
}

function attachmentName(filename: string | undefined, index: number) {
  const base = (filename ?? "").split(/[/\\]/).pop()?.replaceAll("\u0000", "").replace(/[\r\n]/g, "").trim();
  return (base || `Attachment ${index + 1}`).slice(0, 120);
}

function listAttachments(parsed: ParsedMail): PublicAttachment[] {
  return (parsed.attachments ?? []).slice(0, 20).map((attachment, index) => ({
    name: attachmentName(attachment.filename, index),
    contentType: (attachment.contentType ?? "application/octet-stream").slice(0, 120),
    size: typeof attachment.size === "number" ? attachment.size : 0,
  }));
}

async function parseBody(source: Buffer) {
  try {
    const parsed = await simpleParser(source);
    const text = (parsed.text ?? "").slice(0, MAX_TEXT_CHARS);
    const htmlSource = typeof parsed.html === "string" ? parsed.html : "";
    const html = sanitizeInboundHtml(htmlSource);
    const attachments = listAttachments(parsed);
    if (html.length > MAX_HTML_CHARS) {
      return {
        text: text || "This message is too large to display in full.",
        html: "",
        bodyLimited: true,
        attachments,
      };
    }
    if (!text && !html) {
      return {
        text: "This message has no readable body.",
        html: "",
        bodyLimited: false,
        attachments,
      };
    }
    return { text, html, bodyLimited: false, attachments };
  } catch (error) {
    console.error("[mail] message parse", safeErrorDetails(error, []));
    return {
      text: "This message could not be displayed.",
      html: "",
      bodyLimited: false,
      attachments: [],
    };
  }
}

export async function readMailboxMessage(
  config: MailConfig,
  requestedFolder: string,
  uid: number,
): Promise<PublicMessage> {
  return withImap(config, async (client) => {
    const folders = await loadFolders(client);
    const folder = resolveFolder(folders, requestedFolder);
    if (!folder?.selectable) {
      throw new MailboxError("That mailbox folder is not available.", 404, "FOLDER_MISSING");
    }

    const lock = await client.getMailboxLock(folder.path);
    try {
      const meta = await client.fetchOne(
        String(uid),
        { uid: true, size: true, envelope: true, flags: true, internalDate: true },
        { uid: true },
      );
      if (!meta) {
        throw new MailboxError("That message could not be found.", 404, "MESSAGE_MISSING");
      }

      const summary = summarize(meta);
      const to = formatAddresses(meta.envelope?.to, "Unknown recipient");
      if ((meta.size ?? 0) > MAX_MESSAGE_BYTES) {
        return {
          ...summary,
          folder: folder.path,
          to,
          text: "This message is too large to display.",
          html: "",
          bodyLimited: true,
          attachments: [],
        };
      }

      const full = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      const source = full && Buffer.isBuffer(full.source) ? full.source : null;
      const body = source
        ? await parseBody(source)
        : {
            text: "This message could not be displayed.",
            html: "",
            bodyLimited: false,
            attachments: [],
          };
      return {
        ...summary,
        folder: folder.path,
        to,
        ...body,
      };
    } finally {
      lock.release();
    }
  });
}

async function messageIdExists(client: ImapFlow, messageId: string) {
  const bare = messageId.replace(/^<|>$/g, "");
  for (const value of [bare, `<${bare}>`]) {
    const found = await client.search({ header: { "message-id": value } }, { uid: true });
    if (Array.isArray(found) && found.length > 0) {
      return true;
    }
  }
  return false;
}

export async function saveSentCopy(
  config: MailConfig,
  raw: Buffer,
  messageId: string,
  lock: MailLock,
) {
  try {
    return await lock(() =>
      withImap(config, async (client) => {
        const folders = await loadFolders(client);
        const sent = findSentMailbox(folders);
        if (!sent?.selectable) {
          return { status: "folder_missing" as const, errorMessage: null };
        }

        const status = await appendIfMessageMissing({
          lock: (task) => task(),
          exists: async () => {
            const mailboxLock = await client.getMailboxLock(sent.path);
            try {
              if (await messageIdExists(client, messageId)) {
                return true;
              }
              await new Promise((resolve) => setTimeout(resolve, SENT_COPY_RETRY_MS));
              return messageIdExists(client, messageId);
            } finally {
              mailboxLock.release();
            }
          },
          append: async () => Boolean(await client.append(sent.path, raw, ["\\Seen"])),
        });
        return {
          status,
          errorMessage: status === "failed" ? "A copy could not be saved to the sent folder." : null,
        };
      }),
    );
  } catch (error) {
    console.error("[mail] sent copy", safeErrorDetails(error, [config.password]));
    return {
      status: "failed" as const,
      errorMessage: "A copy could not be saved to the sent folder.",
    };
  }
}
