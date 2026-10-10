import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { admin } from "better-auth/plugins";

import { sendstackAccessControl, sendstackAdminRoles } from "./access.js";
import { createDb } from "../db/index.js";
import * as schema from "../db/schema.js";
import { loadEnv } from "../env.js";
import { sendTransactionalEmail } from "../lib/email.js";
import { authTrustedOrigins } from "./origins.js";

const env = loadEnv();
const { db } = createDb(env);

const isProduction = env.NODE_ENV === "production" || env.BETTER_AUTH_URL.startsWith("https://");

export const auth = betterAuth({
  appName: "SendStack",
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: authTrustedOrigins(env.FRONTEND_URL),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  plugins: [
    admin({
      ac: sendstackAccessControl,
      roles: sendstackAdminRoles,
      defaultRole: "user",
      adminRoles: ["super-admin"],
    }),
  ],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      void sendTransactionalEmail(env, {
        to: user.email,
        subject: "Reset your SendStack password",
        text: `You requested a password reset for your SendStack account.\n\nReset your password: ${url}\n\nIf you did not request this, you can ignore this email.`,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      void sendTransactionalEmail(env, {
        to: user.email,
        subject: "Verify your SendStack email",
        text: `Welcome to SendStack.\n\nVerify your email address: ${url}`,
      });
    },
  },
  advanced: {
    defaultCookieAttributes: {
      secure: isProduction,
      sameSite: "lax",
      httpOnly: true,
    },
  },
});

export type Auth = typeof auth;
