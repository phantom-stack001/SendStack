import type { Hono } from "hono";
import { handle } from "hono/vercel";

/**
 * Vercel's Node runtime writes the HTTP response only when the function export
 * exposes `fetch` (Web handler). `handle()` alone is a bare `(req) => app.fetch(req)`
 * function, which that runtime invokes as `(req, res)` and never ends `res`.
 */
export function createVercelFetchHandler(app: Hono) {
  return {
    fetch: handle(app),
  };
}
