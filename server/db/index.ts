import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ServerEnv } from "../env.js";
import * as schema from "./schema.js";

export function createDb(env: ServerEnv) {
  const client = postgres(env.DATABASE_URL, {
    max: 10,
    prepare: false,
  });

  const db = drizzle(client, { schema });
  return { db, client };
}

export type Database = ReturnType<typeof createDb>["db"];
