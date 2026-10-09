import type { Hono } from "hono";
import { z } from "zod";

import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { validationError } from "../lib/http-errors.js";
import { getSessionUser } from "../lib/session.js";
import { serializeContact } from "../services/contacts.js";
import {
  addContactsToList,
  createContactList,
  deleteContactList,
  getContactListById,
  listContactLists,
  listContactsInList,
  removeContactFromList,
  removeContactsFromList,
  serializeContactList,
  updateContactList,
} from "../services/contact-lists.js";
import {
  createContactListSchema,
  listMembersBodySchema,
  updateContactListSchema,
} from "../validation/contacts.js";

const env = loadEnv();
const { db } = createDb(env);

const listIdParamSchema = z.object({ id: z.string().uuid() });

export function registerContactListRoutes(app: Hono) {
  app.get("/api/contact-lists", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const lists = await listContactLists(db, user.id);
    return c.json({ lists });
  });

  app.post("/api/contact-lists", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json().catch(() => null);
    const parsed = createContactListSchema.safeParse(body);
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    try {
      const row = await createContactList(db, user.id, parsed.data);
      if (!row) return c.json({ error: "Could not create list" }, 500);
      return c.json({ list: serializeContactList(row, 0) }, 201);
    } catch (error) {
      if (error instanceof Error && error.message === "DUPLICATE_NAME") {
        return c.json({ error: "A list with this name already exists" }, 409);
      }
      throw error;
    }
  });

  app.get("/api/contact-lists/:id", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = listIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "List not found" }, 404);

    const row = await getContactListById(db, user.id, params.data.id);
    if (!row) return c.json({ error: "List not found" }, 404);

    const detail = await listContactsInList(db, user.id, params.data.id, 1, 1);
    const memberCount = detail?.pagination.total ?? 0;
    return c.json({ list: serializeContactList(row, memberCount) });
  });

  app.patch("/api/contact-lists/:id", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = listIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "List not found" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = updateContactListSchema.safeParse(body);
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    try {
      const row = await updateContactList(db, user.id, params.data.id, parsed.data);
      if (!row) return c.json({ error: "List not found" }, 404);
      const detail = await listContactsInList(db, user.id, params.data.id, 1, 1);
      return c.json({
        list: serializeContactList(row, detail?.pagination.total ?? 0),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "DUPLICATE_NAME") {
        return c.json({ error: "A list with this name already exists" }, 409);
      }
      throw error;
    }
  });

  app.delete("/api/contact-lists/:id", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = listIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "List not found" }, 404);

    const deleted = await deleteContactList(db, user.id, params.data.id);
    if (!deleted) return c.json({ error: "List not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/contact-lists/:id/contacts", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = listIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "List not found" }, 404);

    const page = Number(c.req.query("page") ?? "1");
    const limit = Number(c.req.query("limit") ?? "25");
    const result = await listContactsInList(db, user.id, params.data.id, page, limit);
    if (!result) return c.json({ error: "List not found" }, 404);

    return c.json({
      list: serializeContactList(result.list, result.pagination.total),
      contacts: result.contacts.map((row) => serializeContact(row)),
      pagination: result.pagination,
    });
  });

  app.post("/api/contact-lists/:id/contacts", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = listIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "List not found" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = listMembersBodySchema.safeParse(body);
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    const result = await addContactsToList(
      db,
      user.id,
      params.data.id,
      parsed.data.contactIds,
    );
    if (!result) return c.json({ error: "List not found" }, 404);
    return c.json(result);
  });

  app.delete("/api/contact-lists/:id/contacts/:contactId", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const listId = c.req.param("id");
    const contactId = c.req.param("contactId");
    if (!z.string().uuid().safeParse(listId).success) {
      return c.json({ error: "List not found" }, 404);
    }
    if (!z.string().uuid().safeParse(contactId).success) {
      return c.json({ error: "Contact not found" }, 404);
    }

    const removed = await removeContactFromList(db, user.id, listId, contactId);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/contact-lists/:id/contacts/remove", async (c) => {
    const user = await getSessionUser(c.req.raw.headers);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const params = listIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) return c.json({ error: "List not found" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = listMembersBodySchema.safeParse(body);
    if (!parsed.success) return c.json(validationError(parsed.error), 400);

    const result = await removeContactsFromList(
      db,
      user.id,
      params.data.id,
      parsed.data.contactIds,
    );
    if (!result) return c.json({ error: "List not found" }, 404);
    return c.json(result);
  });
}
