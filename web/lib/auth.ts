export type SessionUser = {
  tokenHash: string;
  csrfToken: string;
  expiresAt: string;
  userId: string;
  email: string;
  name: string;
  role: "admin" | "marketer" | "analyst";
  mustChangePassword: boolean;
};

export function requireCsrf(request: Request, session: Pick<SessionUser, "csrfToken">): string | null {
  const header = request.headers.get("X-CSRF-Token");
  if (!header || header !== session.csrfToken) {
    return "CSRF validation failed.";
  }
  return null;
}

export function passwordChangeAllowedPath(path: string, method: string): boolean {
  const normalized = path.startsWith("/api") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;
  if (normalized === "/api/session" && method === "GET") return true;
  if (normalized === "/api/auth/change-password" && method === "POST") return true;
  if (normalized === "/api/auth/logout" && method === "POST") return true;
  return false;
}
