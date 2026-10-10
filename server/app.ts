import { Hono } from "hono";
import { cors } from "hono/cors";

import { auth } from "./auth/auth.js";
import { authTrustedOrigins } from "./auth/origins.js";
import { permissionForRequest } from "./auth/permissions.js";
import { createDb, probeDatabase, type Database } from "./db/index.js";
import type { ServerEnv } from "./env.js";
import { loadEnv } from "./env.js";
import { safeErrorLabel, logStartup } from "./lib/startup-log.js";
import { getSessionUser } from "./lib/session.js";
import { probeRedis } from "./queue/connection.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerContactImportRoutes } from "./routes/contact-import.js";
import { registerContactListRoutes } from "./routes/contact-lists.js";
import { registerContactRoutes } from "./routes/contacts.js";
import { registerDraftRoutes } from "./routes/drafts.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMailRoutes } from "./routes/mail.js";
import { registerQueueRoutes } from "./routes/queue.js";
import { registerSuppressionRoutes } from "./routes/suppressions.js";
import { seedAccessControl, userHasPermission } from "./services/access-control.js";

export type SendStackApp = {
  app: Hono;
  db: Database;
};

export type CreateAppOptions = {
  /** Persist system roles. Long-running server only — never on the Vercel request path. */
  seedAccess?: boolean;
};

export function createSendStackApp(env: ServerEnv, options: CreateAppOptions = {}): SendStackApp {
  const { db } = createDb(env);
  const app = new Hono();

  const allowedBrowserOrigins = new Set(authTrustedOrigins(env.FRONTEND_URL));

  app.use(
    "/api/*",
    cors({
      origin: (origin) =>
        origin && allowedBrowserOrigins.has(origin) ? origin : env.FRONTEND_URL,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );

  app.use("/api/*", async (c, next) => {
    if (
      c.req.path.startsWith("/api/auth") ||
      c.req.path === "/api/health" ||
      c.req.path === "/api/ping"
    ) {
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

  registerHealthRoutes(app, {
    probeDatabase: () => probeDatabase(env.DATABASE_URL),
    probeRedis,
  });
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

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((error, c) => {
    console.error("[api]", safeErrorLabel(error));
    return c.json({ error: "Internal server error" }, 500);
  });

  const seedAccess = options.seedAccess ?? !process.env.VERCEL;
  if (seedAccess) {
    logStartup("Access control seed started");
    seedAccessControl(db).catch((error) => {
      console.error("[admin] access control seed failed", safeErrorLabel(error));
    });
  } else {
    logStartup("Access control seed skipped");
  }

  logStartup("Hono initialized");
  return { app, db };
}

let cachedApp: Hono | undefined;

/** Singleton Hono app for Vercel serverless (warm invocations reuse the instance). */
export function getSendStackApp(): Hono {
  if (!cachedApp) {
    cachedApp = createSendStackApp(loadEnv(), { seedAccess: false }).app;
  }
  return cachedApp;
}
