import { NextResponse, type NextRequest } from "next/server";

const NO_STORE_PATHS = new Set(["/", "/app", "/index.html", "/app.js", "/styles.css"]);

const SPA_PATHS = new Set(["/app", "/index.html", "/app.js", "/styles.css"]);

function buildCsp(nonce: string, isSpaShell: boolean): string {
  const isDev = process.env.NODE_ENV === "development";

  // Static SPA shell only loads external /app.js — strict-dynamic would block it.
  if (isSpaShell) {
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; ");
  }

  // Next.js App Router needs nonced inline flight scripts to hydrate.
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isSpaShell = SPA_PATHS.has(pathname);
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, isSpaShell);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  if (!isSpaShell) {
    requestHeaders.set("x-nonce", nonce);
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Content-Security-Policy", csp);

  if (NO_STORE_PATHS.has(pathname)) {
    response.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");
  }

  const proto = request.headers.get("x-forwarded-proto");
  if (proto === "https" || request.nextUrl.protocol === "https:") {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
