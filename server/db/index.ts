import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ServerEnv } from "../env.js";
import * as schema from "./schema.js";

type DbBundle = {
  db: ReturnType<typeof drizzle<typeof schema>>;
  client: ReturnType<typeof postgres>;
};

const globalForDb = globalThis as typeof globalThis & {
  sendstackDb?: DbBundle;
};

export function createDb(env: ServerEnv) {
  if (process.env.VERCEL && globalForDb.sendstackDb) {
    return globalForDb.sendstackDb;
  }

  const isServerless = Boolean(process.env.VERCEL);
  const client = postgres(env.DATABASE_URL, {
    max: isServerless ? 1 : 10,
    prepare: false,
    idle_timeout: isServerless ? 20 : undefined,
    connect_timeout: 10,
  });

  const db = drizzle(client, { schema });
  const bundle = { db, client };
  if (isServerless) {
    globalForDb.sendstackDb = bundle;
  }
  return bundle;
}

export type Database = ReturnType<typeof createDb>["db"];
