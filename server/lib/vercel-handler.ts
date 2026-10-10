import type { Hono } from "hono";
import { handle } from "hono/vercel";

/**
 * Optional path carrier when a rewrite collapses the URL to `/api`.
 * The primary path is the original request URL, which Vercel keeps on rewrites.
 */
export const VERCEL_API_PATH_PARAM = "__sendstack_path";

export const VERCEL_API_PATH_HEADER = "x-sendstack-path";

const FUNCTION_MOUNTS = new Set(["/api", "/api/", "/api/index", "/api/index/"]);

const ORIGINAL_PATH_HEADERS = [
  VERCEL_API_PATH_HEADER,
  "x-forwarded-uri",
  "x-original-uri",
  "x-vercel-original-path",
  "x-invoke-path",
] as const;

/**
 * Vercel's Node runtime writes the HTTP response only when the function export
 * exposes `fetch`. `handle()` alone is invoked as `(req, res)` and never ends `res`.
 */
export function createVercelFetchHandler(app: Hono) {
  const fetch = handle(app);
  return {
    fetch(request: Request) {
      return fetch(restoreVercelApiRequest(request));
    },
  };
}

/**
 * Keep the browser path for Hono. When the rewrite replaces the URL with `/api`,
 * rebuild `/api/...` from the forwarded path. Method, headers, cookies, and body stay intact.
 */
export function restoreVercelApiRequest(request: Request): Request {
  const url = new URL(request.url);
  const forwarded = url.searchParams.get(VERCEL_API_PATH_PARAM);
  url.searchParams.delete(VERCEL_API_PATH_PARAM);

  if (!FUNCTION_MOUNTS.has(url.pathname)) {
    return sameUrl(request, url) ? request : cloneRequest(request, url);
  }

  const restored = parseApiTarget(forwarded) ?? originalTargetFromHeaders(request.headers);
  if (restored) {
    url.pathname = restored.pathname;
    if (!url.search && restored.search) url.search = restored.search;
  }
  return sameUrl(request, url) ? request : cloneRequest(request, url);
}

function sameUrl(request: Request, url: URL) {
  return url.href === new URL(request.url).href;
}

function originalTargetFromHeaders(headers: Headers) {
  for (const name of ORIGINAL_PATH_HEADERS) {
    const target = parseApiTarget(headers.get(name));
    if (target) return target;
  }
  return null;
}

function parseApiTarget(value: string | null) {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  let base: URL;
  try {
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      base = new URL(trimmed);
    } else if (trimmed.startsWith("/")) {
      base = new URL(trimmed, "https://sendstack.local");
    } else {
      base = new URL(`/api/${trimmed.replace(/^\/+/, "")}`, "https://sendstack.local");
    }
  } catch {
    return null;
  }
  const pathname = normalizeApiPath(base.pathname);
  if (!pathname || FUNCTION_MOUNTS.has(pathname)) return null;
  return { pathname, search: base.search };
}

function normalizeApiPath(pathname: string) {
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return null;
  const segments = pathname.split("/").slice(2);
  const parts = pathname.endsWith("/") ? segments.slice(0, -1) : segments;
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts.length === 0 ? "/api" : `/api/${parts.join("/")}`;
}

function cloneRequest(request: Request, url: URL) {
  const headers = new Headers(request.headers);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(url, init);
}
