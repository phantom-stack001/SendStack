import type { Hono } from "hono";

import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { validationError } from "../lib/http-errors.js";
import { getSessionUser } from "../lib/session.js";
import {
  bulkDeleteContacts,
  bulkUnsubscribeContacts,
  createContact,
  deleteContact,
  getContactById,
  getContactStats,
  listContacts,
  serializeContact,
  unsubscribeContact,
  updateContact,
} from "../services/contacts.js";
import {
  bulkContactActionSchema,
  contactIdParamSchema,
  createContactSchema,
  listContactsQuerySchema,
  updateContactSchema,
} from "../validation/contacts.js";

const env = loadEnv();
const { db } = createDb(env);

export function registerContactRoutes(app: Hono) {
  app.get("/api/contacts/stats", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const stats = await getContactStats(db, user.id);
    return c.json({ stats });
  });

  app.get("/api/contacts", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const parsed = listContactsQuerySchema.safeParse({
      page: c.req.query("page"),
      limit: c.req.query("limit"),
      q: c.req.query("q"),
      status: c.req.query("status"),
      listId: c.req.query("listId"),
      sort: c.req.query("sort"),
    });
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    const result = await listContacts(db, user.id, parsed.data);
    return c.json(result);
  });

  app.post("/api/contacts", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json().catch(() => null);
    const parsed = createContactSchema.safeParse(body);
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    try {
      const row = await createContact(db, user.id, parsed.data);
      return c.json({ contact: serializeContact(row) }, 201);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "DUPLICATE_EMAIL") {
          return c.json({ error: "A contact with this email already exists" }, 409);
        }
      }
      throw error;
    }
  });

  app.get("/api/contacts/:id", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = contactIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "Contact not found" }, 404);

    const row = await getContactById(db, user.id, params.data.id);
    if (!row) return c.json({ error: "Contact not found" }, 404);
    return c.json({ contact: serializeContact(row) });
  });

  app.patch("/api/contacts/:id", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = contactIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "Contact not found" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = updateContactSchema.safeParse(body);
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    try {
      const row = await updateContact(db, user.id, params.data.id, parsed.data);
      if (!row) return c.json({ error: "Contact not found" }, 404);
      return c.json({ contact: serializeContact(row) });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "DUPLICATE_EMAIL") {
          return c.json({ error: "A contact with this email already exists" }, 409);
        }
      }
      throw error;
    }
  });

  app.delete("/api/contacts/:id", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = contactIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "Contact not found" }, 404);

    const deleted = await deleteContact(db, user.id, params.data.id);
    if (!deleted) return c.json({ error: "Contact not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/contacts/:id/unsubscribe", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = contactIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "Contact not found" }, 404);

    const row = await unsubscribeContact(db, user.id, params.data.id);
    if (!row) return c.json({ error: "Contact not found" }, 404);
    return c.json({ contact: serializeContact(row) });
  });

  app.post("/api/contacts/bulk/unsubscribe", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json().catch(() => null);
    const parsed = bulkContactActionSchema.safeParse(body);
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    const result = await bulkUnsubscribeContacts(db, user.id, parsed.data.contactIds);
    return c.json(result);
  });

  app.post("/api/contacts/bulk/delete", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json().catch(() => null);
    const parsed = bulkContactActionSchema.safeParse(body);
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    const result = await bulkDeleteContacts(db, user.id, parsed.data.contactIds);
    return c.json(result);
  });
}
