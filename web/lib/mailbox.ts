import { ImapFlow } from "imapflow";
import { config } from "./config";

export type MailboxFolder = "inbox" | "sent";

export type MailboxListItem = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  seen: boolean;
};

export type MailboxMessage = MailboxListItem & {
  text: string;
  html: string;
};

const LIST_LIMIT = 50;

export function mailboxConfigured(): boolean {
  return Boolean(
    (process.env.SENDSTACK_SMTP_USERNAME ?? "").trim() &&
      (process.env.SENDSTACK_SMTP_PASSWORD ?? "").trim(),
  );
}

export function mailboxReadAllowed(): boolean {
  if (config.isVercelPreview) return false;
  return mailboxConfigured();
}

function imapHost(): string {
  return (process.env.SENDSTACK_IMAP_HOST ?? "mail.spacemail.com").trim() || "mail.spacemail.com";
}

function imapPort(): number {
  return Number(process.env.SENDSTACK_IMAP_PORT ?? 993) || 993;
}

type ImapClient = {
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  list: () => Promise<Array<{ path: string; specialUse?: string | false }>>;
  mailboxOpen: (path: string) => Promise<{ exists: number }>;
  fetch: (
    range: string,
    options: Record<string, unknown>,
  ) => AsyncIterable<{
    uid: number;
    flags?: Set<string>;
    envelope?: {
      from?: Array<{ name?: string; address?: string }>;
      to?: Array<{ name?: string; address?: string }>;
      subject?: string;
      date?: Date | string;
    };
    source?: Buffer;
    bodyStructure?: unknown;
  }>;
  append: (
    path: string,
    source: string | Buffer,
    flags?: string[],
  ) => Promise<unknown>;
};

/** Test seam: inject a fake IMAP client (never opens a socket). */
let clientFactory: (() => ImapClient) | null = null;

export function setMailboxClientFactoryForTests(factory: (() => ImapClient) | null): void {
  clientFactory = factory;
}

function createClient(): ImapClient {
  if (clientFactory) return clientFactory();
  const user = (process.env.SENDSTACK_SMTP_USERNAME ?? "").trim();
  const pass = (process.env.SENDSTACK_SMTP_PASSWORD ?? "").trim();
  if (!user || !pass) {
    throw new Error("Mailbox credentials are not configured.");
  }
  return new ImapFlow({
    host: imapHost(),
    port: imapPort(),
    secure: true,
    auth: { user, pass },
    logger: false,
  }) as unknown as ImapClient;
}

export function pickSentFolderPath(
  folders: Array<{ path: string; specialUse?: string | false }>,
): string | null {
  const bySpecial = folders.find((folder) => folder.specialUse === "\\Sent");
  if (bySpecial) return bySpecial.path;
  const names = ["Sent", "Sent Items", "Sent Messages", "INBOX.Sent"];
  for (const name of names) {
    const match = folders.find((folder) => folder.path.toLowerCase() === name.toLowerCase());
    if (match) return match.path;
  }
  return null;
}

function formatAddress(
  entries?: Array<{ name?: string; address?: string }>,
): string {
  if (!entries?.length) return "";
  return entries
    .map((entry) => {
      const address = entry.address || "";
      if (entry.name && address) return `${entry.name} <${address}>`;
      return entry.name || address;
    })
    .filter(Boolean)
    .join(", ");
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeMailboxHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1="#"');
}

function parseBodies(source?: Buffer): { text: string; html: string } {
  if (!source) return { text: "", html: "" };
  const raw = source.toString("utf8");
  const htmlMatch = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/i);
  const textMatch = raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/i);
  let html = htmlMatch?.[1]?.trim() || "";
  let text = textMatch?.[1]?.trim() || "";
  if (!html && !text) {
    // Non-multipart: treat whole body after headers as text.
    const parts = raw.split(/\r?\n\r?\n/);
    text = parts.slice(1).join("\n\n").trim();
  }
  if (html) html = sanitizeMailboxHtml(html);
  if (!text && html) text = stripTags(html);
  return { text, html };
}

async function withClient<T>(fn: (client: ImapClient) => Promise<T>): Promise<T> {
  if (!mailboxReadAllowed()) {
    throw new Error("Mailbox reading is not available in this environment.");
  }
  const client = createClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore logout errors */
    }
  }
}

async function resolveFolderPath(client: ImapClient, folder: MailboxFolder): Promise<string> {
  if (folder === "inbox") return "INBOX";
  const folders = await client.list();
  const sent = pickSentFolderPath(folders);
  if (!sent) throw new Error("Could not find the Sent folder on this mailbox.");
  return sent;
}

export async function listMailboxMessages(folder: MailboxFolder): Promise<MailboxListItem[]> {
  return withClient(async (client) => {
    const path = await resolveFolderPath(client, folder);
    const box = await client.mailboxOpen(path);
    if (!box.exists) return [];
    const start = Math.max(1, box.exists - LIST_LIMIT + 1);
    const items: MailboxListItem[] = [];
    for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
      items.push({
        uid: msg.uid,
        from: formatAddress(msg.envelope?.from),
        to: formatAddress(msg.envelope?.to),
        subject: msg.envelope?.subject || "(no subject)",
        date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
        seen: Boolean(msg.flags?.has("\\Seen")),
      });
    }
    return items.reverse();
  });
}

export async function getMailboxMessage(
  folder: MailboxFolder,
  uid: number,
): Promise<MailboxMessage | null> {
  if (!Number.isFinite(uid) || uid < 1) return null;
  return withClient(async (client) => {
    const path = await resolveFolderPath(client, folder);
    await client.mailboxOpen(path);
    let found: MailboxMessage | null = null;
    for await (const msg of client.fetch(String(uid), {
      envelope: true,
      flags: true,
      uid: true,
      source: true,
    })) {
      if (msg.uid !== uid) continue;
      const bodies = parseBodies(msg.source);
      found = {
        uid: msg.uid,
        from: formatAddress(msg.envelope?.from),
        to: formatAddress(msg.envelope?.to),
        subject: msg.envelope?.subject || "(no subject)",
        date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
        seen: Boolean(msg.flags?.has("\\Seen")),
        text: bodies.text,
        html: bodies.html,
      };
    }
    return found;
  });
}

/**
 * Append an RFC822 message into the Sent folder after SMTP accept.
 * Failures are returned; callers must not undo SMTP acceptance.
 */
export async function appendToSentFolder(rawRfc822: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!rawRfc822.trim()) return { ok: false, error: "Empty message source." };
  if (!mailboxConfigured() || config.isVercelPreview) {
    return { ok: false, error: "Mailbox append unavailable." };
  }
  // Tests inject a client factory when they want IMAP; otherwise skip sockets.
  if (config.nodeEnv === "test" && !clientFactory) {
    return { ok: true };
  }
  try {
    const client = createClient();
    await client.connect();
    try {
      const path = await resolveFolderPath(client, "sent");
      await client.append(path, rawRfc822, ["\\Seen"]);
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to append to Sent.",
    };
  }
}

/** Pure helper for tests: build a minimal RFC822 for Sent append. */
export function buildSentAppendSource(input: {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
  ];
  if (input.replyTo) lines.push(`Reply-To: ${input.replyTo}`);
  lines.push("MIME-Version: 1.0");
  if (input.html && input.text) {
    const boundary = "sendstack_boundary";
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, "");
    lines.push(`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", input.text, "");
    lines.push(`--${boundary}`, "Content-Type: text/html; charset=utf-8", "", input.html, "");
    lines.push(`--${boundary}--`);
  } else if (input.html) {
    lines.push("Content-Type: text/html; charset=utf-8", "", input.html);
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8", "", input.text || "");
  }
  return lines.join("\r\n");
}
