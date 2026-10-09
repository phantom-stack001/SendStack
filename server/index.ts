import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { auth } from "./auth/auth.js";
import { permissionForRequest } from "./auth/permissions.js";
import { createDb } from "./db/index.js";
import { loadEnv } from "./env.js";
import { getSessionUser } from "./lib/session.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerContactImportRoutes } from "./routes/contact-import.js";
import { seedAccessControl, userHasPermission } from "./services/access-control.js";
import { registerContactListRoutes } from "./routes/contact-lists.js";
import { registerContactRoutes } from "./routes/contacts.js";
import { registerDraftRoutes } from "./routes/drafts.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerMailRoutes } from "./routes/mail.js";
import { registerQueueRoutes } from "./routes/queue.js";
import { registerSuppressionRoutes } from "./routes/suppressions.js";

const env = loadEnv();
const { db } = createDb(env);
const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: env.FRONTEND_URL,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth") || c.req.path.startsWith("/api/health")) {
    return next();
  }
  const account = await getSessionUser(c.req.raw.headers);
  if (account && (account as { banned?: boolean | null }).banned) {
    return c.json({ error: "This account cannot access SendStack." }, 403);
  }
  const permission = permissionForRequest(c.req.path, c.req.method);
  if (!permission) return next();
  if (!account) return c.json({ error: "Unauthorized" }, 401);
  const allowed = await userHasPermission(db, account, permission);
  if (!allowed) return c.json({ error: "You do not have permission to do that." }, 403);
  return next();
});

registerHealthRoutes(app);
registerAdminRoutes(app);
registerDraftRoutes(app);
registerContactRoutes(app);
registerContactListRoutes(app);
registerContactImportRoutes(app);
registerSuppressionRoutes(app);
registerCampaignRoutes(app);
registerQueueRoutes(app);
registerMailRoutes(app);

app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

app.onError((error, c) => {
  console.error("[api]", error);
  return c.json({ error: "Internal server error" }, 500);
});

seedAccessControl(db).catch((error) => {
  console.error("[admin] access control seed failed", error instanceof Error ? error.message : "Error");
});

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.info(`SendStack API listening on http://localhost:${info.port}`);
  },
);
