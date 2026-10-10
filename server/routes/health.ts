import { sql } from "drizzle-orm";
import type { Hono } from "hono";

import type { Database } from "../db/index.js";
import { probeRedis } from "../queue/connection.js";

export function registerHealthRoutes(app: Hono, db: Database) {
  app.get("/api/health", async (c) => {
    let database: "ok" | "unavailable" = "unavailable";
    try {
      await db.execute(sql`select 1`);
      database = "ok";
    } catch (error) {
      console.error("[health] database", error instanceof Error ? error.name : "Error");
    }

    const redis = await probeRedis();
    const ok = database === "ok";
    return c.json(
      {
        ok,
        service: "sendstack-api",
        checks: { api: "ok", database, redis },
        timestamp: new Date().toISOString(),
      },
      ok ? 200 : 503,
    );
  });
}
