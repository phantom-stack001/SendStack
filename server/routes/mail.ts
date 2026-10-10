import type { Context, Hono } from "hono";

import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { validationError } from "../lib/http-errors.js";
import type { PermissionKey } from "../auth/permissions.js";
import { getSessionUser } from "../lib/session.js";
import { userHasPermission } from "../services/access-control.js";
import { loadMailConfig } from "../mail/configuration.js";
import { MailboxError } from "../mail/errors.js";
import {
  listMailboxFolders,
  listMailboxMessages,
  listSentMessages,
  readMailboxMessage,
} from "../mail/imap.js";
import { getMailboxStatus, testMailboxConnection } from "../services/mail-connection.js";
import { sendControlledTest } from "../services/mail-test-send.js";
import { sendIndividualEmail } from "../services/individual-send.js";
import { listIndividualSubmissions } from "../services/individual-send-records.js";
import { toPublicIndividualSend } from "../mail/individual-send-public.js";
import { mailboxFolderSchema, mailPageQuerySchema, mailUidSchema, testSendSchema, individualSendSchema, individualSendListQuerySchema } from "../validation/mail.js";

const env = loadEnv();
const { db } = createDb(env);

/**
 * Direct mailbox access for the configured account.
 * Campaign queues are not used by these routes.
 */
function json(c: Context, body: unknown, status: 200 | 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503 = 200) {
  c.header("Cache-Control", "no-store");
  return c.json(body, status);
}

async function requireMailbox(c: Context, permission: PermissionKey) {
  const user = await getSessionUser(c.req.raw.headers);
  if (!user) {
    return { response: json(c, { error: "Unauthorized" }, 401) };
  }
  if ((user as { banned?: boolean | null }).banned) {
    return { response: json(c, { error: "This account cannot access SendStack." }, 403) };
  }
  const allowed = await userHasPermission(db, user, permission);
  if (!allowed) {
    return { response: json(c, { error: "You do not have permission to use the mailbox." }, 403) };
  }
  return { user };
}

function pageQuery(c: Context) {
  return mailPageQuerySchema.safeParse({
    page: c.req.query("page") ?? "1",
    limit: c.req.query("limit") ?? "25",
  });
}

export function registerMailRoutes(app: Hono) {
  app.get("/api/mail/status", async (c) => {
    const access = await requireMailbox(c, "mailbox.read");
    if ("response" in access) return access.response;
    const status = await getMailboxStatus(db);
    return json(c, status);
  });

  app.post("/api/mail/test-connection", async (c) => {
    const access = await requireMailbox(c, "mailbox.manage_connection");
    if ("response" in access) return access.response;
    const result = await testMailboxConnection(db, access.user.id);
    if (result.kind === "not_configured") {
      return json(c, { error: "Email account is not configured on the server." }, 503);
    }
    if (result.kind === "rate_limited") {
      return json(c, { error: "Wait a few seconds before testing the connection again." }, 429);
    }
    return json(c, result.status);
  });

  app.post("/api/mail/test-send", async (c) => {
    const access = await requireMailbox(c, "mailbox.send_test");
    if ("response" in access) return access.response;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(c, { error: "Invalid JSON body" }, 400);
    }

    const parsed = testSendSchema.safeParse(body);
    if (!parsed.success) {
      return json(c, validationError(parsed.error), 400);
    }

    try {
      const outcome = await sendControlledTest(db, access.user.id, parsed.data);
      if (outcome.kind === "not_configured") {
        return json(c, { error: "Email account is not configured on the server." }, 503);
      }
      if (outcome.kind === "in_progress") {
        return json(c, { error: "A test message is already being sent." }, 409);
      }
      if (outcome.kind === "rate_limited") {
        return json(c, { error: outcome.message }, 429);
      }
      if (outcome.kind === "duplicate") {
        return json(c, { submission: outcome.submission, duplicate: true });
      }
      if (outcome.kind === "accepted") {
        return json(c, { submission: outcome.submission, duplicate: false });
      }
      return json(
        c,
        {
          error: outcome.submission.errorMessage ?? "The message was not accepted.",
          submission: outcome.submission,
        },
        502,
      );
    } catch (error) {
      if (error instanceof MailboxError) {
        return json(c, { error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.get("/api/mail/sends", async (c) => {
    const access = await requireMailbox(c, "mailbox.send");
    if ("response" in access) return access.response;
    const parsed = individualSendListQuerySchema.safeParse({
      page: c.req.query("page") ?? "1",
      limit: c.req.query("limit") ?? "10",
    });
    if (!parsed.success) return json(c, validationError(parsed.error), 400);
    const { rows, total } = await listIndividualSubmissions(
      db,
      access.user.id,
      parsed.data.page,
      parsed.data.limit,
    );
    return json(c, {
      submissions: rows.map((row) => toPublicIndividualSend(row)),
      pagination: {
        page: parsed.data.page,
        limit: parsed.data.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / parsed.data.limit)),
      },
    });
  });

  app.post("/api/mail/send", async (c) => {
    const access = await requireMailbox(c, "mailbox.send");
    if ("response" in access) return access.response;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(c, { error: "Invalid JSON body" }, 400);
    }
    const parsed = individualSendSchema.safeParse(body);
    if (!parsed.success) return json(c, validationError(parsed.error), 400);

    const outcome = await sendIndividualEmail(db, access.user.id, {
      ...parsed.data,
      draftId: parsed.data.draftId ?? null,
    });
    if (outcome.kind === "not_configured") {
      return json(c, { error: "Email account is not configured on the server." }, 503);
    }
    if (outcome.kind === "invalid") return json(c, { error: outcome.message }, 400);
    if (outcome.kind === "forbidden_draft") return json(c, { error: "Draft not found." }, 404);
    if (outcome.kind === "rate_limited") return json(c, { error: outcome.message }, 429);
    if (outcome.kind === "in_progress") {
      return json(c, { error: "This message is already being sent.", submission: outcome.submission }, 409);
    }
    if (outcome.kind === "duplicate") {
      return json(c, { submission: outcome.submission, duplicate: true });
    }
    if (outcome.kind === "accepted") {
      return json(c, { submission: outcome.submission, duplicate: false });
    }
    if (outcome.kind === "uncertain") {
      return json(c, { error: outcome.submission.note, submission: outcome.submission }, 409);
    }
    return json(
      c,
      { error: outcome.submission.errorMessage ?? outcome.submission.note, submission: outcome.submission },
      502,
    );
  });

  app.get("/api/mail/folders", async (c) => {
    const access = await requireMailbox(c, "mailbox.read");
    if ("response" in access) return access.response;
    const loaded = loadMailConfig();
    if (!loaded.ok) {
      console.error("[mail] configuration unavailable", loaded.reason);
      return json(c, { error: "Email account is not configured on the server." }, 503);
    }
    try {
      const folders = await listMailboxFolders(loaded.config);
      return json(c, { folders });
    } catch (error) {
      if (error instanceof MailboxError) {
        return json(c, { error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.get("/api/mail/inbox", async (c) => {
    const access = await requireMailbox(c, "mailbox.read");
    if ("response" in access) return access.response;
    const page = pageQuery(c);
    if (!page.success) {
      return json(c, validationError(page.error), 400);
    }
    const loaded = loadMailConfig();
    if (!loaded.ok) {
      console.error("[mail] configuration unavailable", loaded.reason);
      return json(c, { error: "Email account is not configured on the server." }, 503);
    }
    try {
      const result = await listMailboxMessages(
        loaded.config,
        "INBOX",
        page.data.page,
        page.data.limit,
      );
      return json(c, result);
    } catch (error) {
      if (error instanceof MailboxError) {
        return json(c, { error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.get("/api/mail/sent", async (c) => {
    const access = await requireMailbox(c, "mailbox.read");
    if ("response" in access) return access.response;
    const page = pageQuery(c);
    if (!page.success) {
      return json(c, validationError(page.error), 400);
    }
    const loaded = loadMailConfig();
    if (!loaded.ok) {
      console.error("[mail] configuration unavailable", loaded.reason);
      return json(c, { error: "Email account is not configured on the server." }, 503);
    }
    try {
      const result = await listSentMessages(loaded.config, page.data.page, page.data.limit);
      return json(c, result);
    } catch (error) {
      if (error instanceof MailboxError) {
        return json(c, { error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.get("/api/mail/mailbox", async (c) => {
    const access = await requireMailbox(c, "mailbox.read");
    if ("response" in access) return access.response;
    const folder = mailboxFolderSchema.safeParse(c.req.query("folder") ?? "");
    if (!folder.success) {
      return json(c, { error: "That mailbox folder is not available." }, 404);
    }
    const page = pageQuery(c);
    if (!page.success) {
      return json(c, validationError(page.error), 400);
    }
    const loaded = loadMailConfig();
    if (!loaded.ok) {
      console.error("[mail] configuration unavailable", loaded.reason);
      return json(c, { error: "Email account is not configured on the server." }, 503);
    }
    try {
      const result = await listMailboxMessages(
        loaded.config,
        folder.data,
        page.data.page,
        page.data.limit,
      );
      return json(c, result);
    } catch (error) {
      if (error instanceof MailboxError) {
        return json(c, { error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.get("/api/mail/messages/:uid", async (c) => {
    const access = await requireMailbox(c, "mailbox.read");
    if ("response" in access) return access.response;
    const uid = mailUidSchema.safeParse(c.req.param("uid"));
    const folder = mailboxFolderSchema.safeParse(c.req.query("folder") ?? "");
    if (!uid.success || !folder.success) {
      return json(c, { error: "That message could not be found." }, 404);
    }
    const loaded = loadMailConfig();
    if (!loaded.ok) {
      console.error("[mail] configuration unavailable", loaded.reason);
      return json(c, { error: "Email account is not configured on the server." }, 503);
    }
    try {
      const message = await readMailboxMessage(loaded.config, folder.data, Number(uid.data));
      return json(c, { message });
    } catch (error) {
      if (error instanceof MailboxError) {
        return json(c, { error: error.message }, error.status);
      }
      throw error;
    }
  });
}
