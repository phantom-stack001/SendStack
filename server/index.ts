import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { auth } from "./auth/auth.js";
import { loadEnv } from "./env.js";
import { registerDraftRoutes } from "./routes/drafts.js";
import { registerHealthRoutes } from "./routes/health.js";

const env = loadEnv();
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

registerHealthRoutes(app);
registerDraftRoutes(app);

app.get("/api/me", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.json({
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      role: (session.user as { role?: string }).role ?? "user",
    },
  });
});

app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

app.onError((error, c) => {
  console.error("[api]", error);
  return c.json({ error: "Internal server error" }, 500);
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
