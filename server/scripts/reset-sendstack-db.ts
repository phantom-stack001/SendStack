import { config } from "dotenv";
import postgres from "postgres";

import { SENDSTACK_RESET_TABLES } from "../lib/sendstack-tables.js";
import { fetchDatabaseInventory, parseDatabaseUrl } from "../lib/db-identity.js";

config();

const databaseUrl = process.env.DATABASE_URL;
const confirm = process.env.SENDSTACK_DB_RESET_CONFIRM === "yes";

if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

if (!confirm) {
  console.error(
    "Refusing to reset: set SENDSTACK_DB_RESET_CONFIRM=yes after reviewing the scoped table list.",
  );
  process.exit(1);
}

const identity = parseDatabaseUrl(databaseUrl);
const sql = postgres(databaseUrl, { max: 1, prepare: false });

try {
  const inventory = await fetchDatabaseInventory(sql);
  const existing = new Set(inventory.tables.map((name) => name.replace(/^public\./, "")));
  const toDrop = SENDSTACK_RESET_TABLES.filter((table) => existing.has(table));
  const unknownPublic = inventory.tables
    .map((name) => name.replace(/^public\./, ""))
    .filter((table) => !SENDSTACK_RESET_TABLES.includes(table as (typeof SENDSTACK_RESET_TABLES)[number]));

  console.info("SendStack database reset — target identity:");
  console.info(JSON.stringify({ ...identity, connectedAs: inventory.identity.db_user }, null, 2));
  console.info(`Public tables found: ${inventory.tables.length}`);
  if (unknownPublic.length > 0) {
    console.error("Unexpected public tables outside the SendStack allowlist:");
    for (const table of unknownPublic) {
      console.error(`  - ${table}`);
    }
    console.error("Aborting. Extend the allowlist only after manual review.");
    process.exit(1);
  }

  console.info("Tables scheduled for removal:");
  for (const table of toDrop) {
    console.info(`  - public.${table}`);
  }

  if (toDrop.length === 0) {
    console.info("No SendStack tables to drop — database is already empty.");
    process.exit(0);
  }

  for (const table of toDrop) {
    await sql.unsafe(`DROP TABLE IF EXISTS "public"."${table}" CASCADE`);
  }

  console.info("Reset complete.");
} finally {
  await sql.end();
}
