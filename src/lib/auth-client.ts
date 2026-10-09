import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";

const baseURL =
  typeof import.meta.env.VITE_APP_URL === "string" && import.meta.env.VITE_APP_URL.length > 0
    ? import.meta.env.VITE_APP_URL
    : undefined;

export const authClient = createAuthClient({
  baseURL,
  plugins: [adminClient()],
});

export type AuthSession = typeof authClient.$Infer.Session;
