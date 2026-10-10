import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { safeErrorLabel } from "../lib/startup-log.js";
import { registerHealthRoutes } from "../routes/health.js";

describe("health routes", () => {
  it("answers ping without database or redis", async () => {
    const app = new Hono();
    let probes = 0;
    registerHealthRoutes(app, {
      probeDatabase: async () => {
        probes += 1;
        return "ok";
      },
      probeRedis: async () => {
        probes += 1;
        return "ok";
      },
    });

    const response = await app.request("http://localhost/api/ping");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "sendstack-api" });
    expect(probes).toBe(0);
  });

  it("returns JSON when the database probe never settles", async () => {
    const app = new Hono();
    registerHealthRoutes(
      app,
      {
        probeDatabase: () => new Promise(() => undefined),
        probeRedis: async () => "disabled",
      },
      { databaseMs: 30, redisMs: 30 },
    );

    const started = Date.now();
    const response = await app.request("http://localhost/api/health");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      ok: boolean;
      checks: { database: string; redis: string };
    };
    expect(body.ok).toBe(false);
    expect(body.checks.database).toBe("unavailable");
    expect(body.checks.redis).toBe("disabled");
  });

  it("does not report success when the database is unavailable", async () => {
    const app = new Hono();
    registerHealthRoutes(app, {
      probeDatabase: async () => "unavailable",
      probeRedis: async () => "ok",
    });

    const response = await app.request("http://localhost/api/health");
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      ok: boolean;
      checks: { api: string; database: string; redis: string };
    };
    expect(body.ok).toBe(false);
    expect(body.checks).toMatchObject({ api: "ok", database: "unavailable", redis: "ok" });
  });

  it("reports redis failure without failing a healthy database", async () => {
    const app = new Hono();
    registerHealthRoutes(app, {
      probeDatabase: async () => "ok",
      probeRedis: async () => "unavailable",
    });

    const response = await app.request("http://localhost/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; checks: { redis: string } };
    expect(body.ok).toBe(true);
    expect(body.checks.redis).toBe("unavailable");
  });
});

describe("safe error labels", () => {
  it("strips database and redis urls", () => {
    const error = new Error(
      "connect failed postgres://user:secret@db.example/app rediss://default:secret@example.upstash.io:6379",
    );
    const label = safeErrorLabel(error);
    expect(label).not.toContain("secret");
    expect(label).not.toContain("postgres://");
    expect(label).not.toContain("rediss://");
  });
});
