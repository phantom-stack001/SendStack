import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { describe, expect, it } from "vitest";

import { createVercelFetchHandler } from "../lib/vercel-handler.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function listen(server: Server) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

async function close(server: Server) {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("vercel fetch handler", () => {
  it("exposes fetch so the Node runtime can finish the response", async () => {
    const app = new Hono();
    app.get("/api/ping", (c) => c.json({ ok: true, service: "sendstack-api" }));
    const handler = createVercelFetchHandler(app);
    expect(typeof handler.fetch).toBe("function");

    const server = createServer(getRequestListener(handler.fetch, { overrideGlobalObjects: false }));
    try {
      const port = await listen(server);
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, service: "sendstack-api" });
    } finally {
      await close(server);
    }
  });

  it("does not end a Node response when handle() is used as a req/res listener", async () => {
    const app = new Hono();
    app.get("/api/ping", (c) => c.json({ ok: true, service: "sendstack-api" }));
    const webOnly = handle(app);
    expect(typeof (webOnly as { fetch?: unknown }).fetch).not.toBe("function");

    const server = createServer((req, res) => {
      void (webOnly as (request: unknown, response: unknown) => unknown)(req, res);
    });
    try {
      const port = await listen(server);
      await expect(
        fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(400) }),
      ).rejects.toThrow();
    } finally {
      await close(server);
    }
  });

  it("keeps the api entry on the shared Hono app without starting workers", () => {
    const source = readFileSync(path.join(root, "api/index.ts"), "utf8");
    expect(source).toContain("createVercelFetchHandler(getSendStackApp())");
    expect(source).not.toContain("email-processing.worker");
    expect(source).not.toContain("campaign-dispatcher");
    expect(source).not.toContain("@hono/node-server");
    expect(source).not.toContain("serve(");

    const appSource = readFileSync(path.join(root, "server/app.ts"), "utf8");
    expect(appSource).toContain("registerMailRoutes");
    expect(appSource).toContain('app.all("/api/auth/*"');
    expect(appSource).toContain("seedAccess: false");
    expect(appSource).not.toContain("email-processing.worker");
    expect(appSource).not.toContain("campaign-dispatcher");
  });
});
