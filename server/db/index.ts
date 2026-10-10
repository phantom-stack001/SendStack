import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ServerEnv } from "../env.js";
import { safeErrorLabel } from "../lib/startup-log.js";
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
  // postgres.js connects on the first query. Serverless keeps a single connection
  // and drops it quickly so a frozen isolate does not hold a Neon session open.
  const client = postgres(env.DATABASE_URL, {
    max: isServerless ? 1 : 10,
    prepare: false,
    connect_timeout: isServerless ? 8 : 10,
    ...(isServerless ? { idle_timeout: 5, max_lifetime: 60 * 5 } : {}),
  });

  const db = drizzle(client, { schema });
  const bundle = { db, client };
  if (isServerless) {
    globalForDb.sendstackDb = bundle;
  }
  return bundle;
}

export type Database = ReturnType<typeof createDb>["db"];

const HEALTH_DATABASE_MS = 5_000;

/**
 * Dedicated short-lived connection for /api/health.
 * It does not use the request pool, so a stuck startup query cannot block it,
 * and ending the client stops postgres.js from retrying the socket forever.
 */
export async function probeDatabase(databaseUrl: string): Promise<"ok" | "unavailable"> {
  if (!databaseUrl.trim()) return "unavailable";
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 1,
    connect_timeout: 4,
    max_lifetime: 15,
    connection: {
      application_name: "sendstack-health",
      statement_timeout: 4000,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = client`select 1`.then(
    () => "ok" as const,
    (error: unknown) => {
      console.error("[health] database", safeErrorLabel(error));
      return "unavailable" as const;
    },
  );
  try {
    return await Promise.race([
      attempt,
      new Promise<"unavailable">((resolve) => {
        timer = setTimeout(() => {
          console.error("[health] database timed out");
          resolve("unavailable");
        }, HEALTH_DATABASE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await new Promise<void>((resolve) => {
      const backup = setTimeout(resolve, 500);
      client.end({ timeout: 0 }).then(
        () => {
          clearTimeout(backup);
          resolve();
        },
        () => {
          clearTimeout(backup);
          resolve();
        },
      );
    });
  }
}
