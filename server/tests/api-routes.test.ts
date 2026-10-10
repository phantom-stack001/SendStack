import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { getSendStackApp } from "../app.js";
import { vercelApiMiddleware } from "../lib/vercel-middleware.js";
import {
  VERCEL_API_PATH_HEADER,
  VERCEL_API_PATH_PARAM,
  createVercelFetchHandler,
  restoreVercelApiRequest,
} from "../lib/vercel-handler.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fixtureApp() {
  const app = new Hono();
  app.get("/api/ping", (c) => c.json({ ok: true, service: "sendstack-api", path: c.req.path }));
  app.get("/api/health", (c) => c.json({ ok: true, path: c.req.path }));
  app.get("/api/auth/get-session", (c) => c.json({ path: c.req.path, cookie: c.req.header("cookie") ?? null }));
  app.post("/api/auth/sign-in/email", async (c) =>
    c.json({ path: c.req.path, cookie: c.req.header("cookie") ?? null, body: await c.req.json() }),
  );
  app.get("/api/admin/users", (c) => c.json({ path: c.req.path }));
  app.patch("/api/admin/users/:userId", async (c) =>
    c.json({ path: c.req.path, body: await c.req.json() }),
  );
  app.delete("/api/admin/users/:userId", (c) => c.json({ path: c.req.path }));
  app.get("/api/mail/status", (c) => c.json({ path: c.req.path }));
  app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));
  return createVercelFetchHandler(app);
}

function rewritten(pathname: string, init?: RequestInit) {
  const suffix = pathname.replace(/^\/api\/?/, "");
  const url = new URL("http://localhost/api");
  if (suffix) url.searchParams.set(VERCEL_API_PATH_PARAM, suffix);
  return new Request(url, init);
}

describe("vercel api rewrites", () => {
  const vercel = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as {
    rewrites: { source: string; destination: string }[];
    functions: Record<string, { maxDuration?: number }>;
  };

  it("sends every nested api path to the single function before the spa fallback", () => {
    expect(vercel.rewrites[0]).toEqual({
      source: "/api/:path*",
      destination: "/api",
    });
    expect(vercel.rewrites[1]?.destination).toBe("/index.html");
    expect(vercel.functions["api/index.ts"]?.maxDuration).toBe(30);
    expect(vercel.rewrites.some((rule) => rule.destination.includes("[...path]"))).toBe(false);
  });

  it("keeps frontend routes on the spa and api routes off index.html", () => {
    const source = vercel.rewrites[1]?.source ?? "";
    const pattern = new RegExp(`^${source}$`);
    expect(pattern.test("/")).toBe(true);
    expect(pattern.test("/login/")).toBe(true);
    expect(pattern.test("/apiary")).toBe(true);
    expect(pattern.test("/api")).toBe(false);
    expect(pattern.test("/api/ping")).toBe(false);
    expect(pattern.test("/api/auth/get-session")).toBe(false);
    expect(pattern.test("/api/mail/status")).toBe(false);
    expect(pattern.test("/assets/app.js")).toBe(false);
    expect(pattern.test("/favicon.svg")).toBe(false);
  });
});

describe("restored vercel requests", () => {
  const handler = fixtureApp();

  it.each([
    ["/api/ping", "GET"],
    ["/api/health", "GET"],
    ["/api/auth/get-session", "GET"],
    ["/api/admin/users", "GET"],
    ["/api/mail/status", "GET"],
  ])("routes %s %s through the rewritten function url", async (pathname, method) => {
    const response = await handler.fetch(rewritten(pathname, { method }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe(pathname);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("forwards post body, cookie, and nested auth path", async () => {
    const response = await handler.fetch(
      rewritten("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=abc" },
        body: JSON.stringify({ email: "person@example.com", password: "not-used" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/api/auth/sign-in/email",
      cookie: "session=abc",
      body: { email: "person@example.com", password: "not-used" },
    });
  });

  it("forwards patch and delete on nested admin paths", async () => {
    const patch = await handler.fetch(
      rewritten("/api/admin/users/user_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    );
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ path: "/api/admin/users/user_1", body: { name: "Ada" } });

    const deleted = await handler.fetch(rewritten("/api/admin/users/user_1", { method: "DELETE" }));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ path: "/api/admin/users/user_1" });
  });

  it("keeps an already preserved url and drops the internal path parameter", async () => {
    const request = new Request(
      `http://localhost/api/auth/get-session?${VERCEL_API_PATH_PARAM}=ignored&fresh=1`,
      { headers: { cookie: "session=kept" } },
    );
    const restored = restoreVercelApiRequest(request);
    const url = new URL(restored.url);
    expect(url.pathname).toBe("/api/auth/get-session");
    expect(url.searchParams.get("fresh")).toBe("1");
    expect(url.searchParams.has(VERCEL_API_PATH_PARAM)).toBe(false);
    expect(restored.headers.get("cookie")).toBe("session=kept");
  });

  it("restores a nested path from the original-uri header when the query parameter is absent", () => {
    const request = new Request("http://localhost/api", {
      headers: { "x-forwarded-uri": "/api/mail/status" },
    });
    expect(new URL(restoreVercelApiRequest(request).url).pathname).toBe("/api/mail/status");
  });

  it("restores path and query from the middleware path header", () => {
    const request = new Request("http://localhost/api", {
      headers: { [VERCEL_API_PATH_HEADER]: "/api/auth/get-session?fresh=1" },
    });
    const url = new URL(restoreVercelApiRequest(request).url);
    expect(url.pathname).toBe("/api/auth/get-session");
    expect(url.searchParams.get("fresh")).toBe("1");
  });

  it("rewrites nested api requests to the single function and records the original path", () => {
    const response = vercelApiMiddleware(
      new Request("http://localhost/api/auth/sign-in/email?fresh=1", {
        method: "POST",
        headers: { cookie: "session=abc", "content-type": "application/json" },
      }),
    );
    expect(response?.headers.get("x-middleware-rewrite")).toBe("/api");
    expect(response?.headers.get(`x-middleware-request-${VERCEL_API_PATH_HEADER}`)).toBe(
      "/api/auth/sign-in/email?fresh=1",
    );
    expect(vercelApiMiddleware(new Request("http://localhost/login/"))).toBeUndefined();
    expect(vercelApiMiddleware(new Request("http://localhost/api/mail/status"))).toBeDefined();
  });

  it("returns json for an unknown api path", async () => {
    const response = await handler.fetch(rewritten("/api/not/a-real-route"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found", path: "/api/not/a-real-route" });
  });

  it("does not let a forwarded path escape /api", () => {
    const request = new Request(`http://localhost/api?${VERCEL_API_PATH_PARAM}=../login`);
    expect(new URL(restoreVercelApiRequest(request).url).pathname).toBe("/api");
  });
});

describe("mounted sendstack routes", () => {
  const app = getSendStackApp();

  it("registers ping, health, auth, admin, and mailbox routes", () => {
    const routes = app.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`);
    expect(routes).toContain("GET /api/ping");
    expect(routes).toContain("GET /api/health");
    expect(routes).toContain("ALL /api/auth/*");
    expect(routes).toContain("GET /api/admin/users");
    expect(routes).toContain("GET /api/mail/status");
  });

  it("matches nested better auth paths on the auth wildcard", async () => {
    const probe = new Hono();
    probe.all("/api/auth/*", (c) => c.json({ path: c.req.path }));
    const response = await probe.request("/api/auth/sign-in/email", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/api/auth/sign-in/email" });
    expect(app.routes.some((route) => route.path === "/api/auth/*")).toBe(true);
  });

  it("returns a json 404 for an unknown api path", async () => {
    const response = await app.request("http://localhost/api/not-a-real-route");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
