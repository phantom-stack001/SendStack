import { VERCEL_API_PATH_HEADER } from "./vercel-handler.js";

/**
 * Edge routing for nested `/api/*` paths.
 * Non-Next.js functions only match one path segment, so this rewrite sends
 * every API request to `/api` and keeps the browser path on a request header.
 */
export function vercelApiMiddleware(request: Request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/") return;
  const headers = new Headers();
  headers.set("x-middleware-rewrite", "/api");
  headers.set(`x-middleware-request-${VERCEL_API_PATH_HEADER}`, `${url.pathname}${url.search}`);
  return new Response(null, { headers });
}
