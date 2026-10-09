import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { eq } from "drizzle-orm";

import { auth } from "../auth/auth.js";
import { createDb } from "../db/index.js";
import * as schema from "../db/schema.js";
import { loadEnv } from "../env.js";
import { fetchDatabaseInventory } from "../lib/db-identity.js";
import { validatePassword } from "../lib/password-policy.js";

const SUPER_ADMIN_ROLE = "super-admin";

async function readPasswordSecurely(): Promise<string> {
  const fromEnv = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "Set BOOTSTRAP_ADMIN_PASSWORD for non-interactive use, or run this script in a terminal.",
    );
  }

  const rl = createInterface({ input, output });
  const password = await rl.question("Bootstrap administrator password: ");
  rl.close();
  return password;
}

const env = loadEnv();
const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "roux.thomas@ctn-sk.com").trim().toLowerCase();
const displayName = (process.env.BOOTSTRAP_ADMIN_NAME ?? "Thomas Roux").trim();

const { db, client } = createDb(env);

try {
  const inventory = await fetchDatabaseInventory(client);
  const required = ["user", "account", "session", "verification"];
  const present = new Set(inventory.tables.map((name) => name.replace(/^public\./, "")));
  const missing = required.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(`Missing Better Auth tables: ${missing.join(", ")}. Run npm run db:migrate first.`);
  }

  const existing = await db.select().from(schema.user).where(eq(schema.user.email, email)).limit(1);
  if (existing.length > 0) {
    console.error(`Administrator already exists for ${email}. No changes were made.`);
    process.exit(1);
  }

  const password = await readPasswordSecurely();
  const passwordError = validatePassword(password);
  if (passwordError) {
    throw new Error(passwordError);
  }

  const signUp = await auth.api.signUpEmail({
    body: {
      name: displayName,
      email,
      password,
    },
  });

  if (!signUp?.user?.id) {
    throw new Error("Better Auth did not return a created user.");
  }

  await db
    .update(schema.user)
    .set({
      emailVerified: true,
      role: SUPER_ADMIN_ROLE,
      banned: false,
      banReason: null,
      banExpires: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.user.id, signUp.user.id));

  const [verified] = await db
    .select({
      id: schema.user.id,
      email: schema.user.email,
      emailVerified: schema.user.emailVerified,
      role: schema.user.role,
      name: schema.user.name,
    })
    .from(schema.user)
    .where(eq(schema.user.id, signUp.user.id))
    .limit(1);

  const [credential] = await db
    .select({ password: schema.account.password })
    .from(schema.account)
    .where(eq(schema.account.userId, signUp.user.id))
    .limit(1);

  if (!verified?.emailVerified || verified.role !== SUPER_ADMIN_ROLE) {
    throw new Error("Administrator role or verification state was not applied correctly.");
  }

  if (!credential?.password || credential.password.length < 20) {
    throw new Error("Credential account was not created with a password hash.");
  }

  console.info("Super administrator provisioned successfully:");
  console.info(
    JSON.stringify(
      {
        email: verified.email,
        name: verified.name,
        role: verified.role,
        emailVerified: verified.emailVerified,
        passwordStoredAsHash: true,
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}
