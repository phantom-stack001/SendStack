import { auth } from "../auth/auth.js";

export async function getSessionUser(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    return null;
  }
  return session.user;
}
