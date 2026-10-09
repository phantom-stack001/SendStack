import { config } from "dotenv";
import postgres from "postgres";

import { fetchDatabaseInventory, parseDatabaseUrl } from "../lib/db-identity.js";
import { SENDSTACK_RESET_TABLES } from "../lib/sendstack-tables.js";

config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, prepare: false });

try {
  const identity = parseDatabaseUrl(databaseUrl);
  const inventory = await fetchDatabaseInventory(sql);
  const publicTables = inventory.tables.map((name) => name.replace(/^public\./, ""));
  const inScope = publicTables.filter((table) =>
    SENDSTACK_RESET_TABLES.includes(table as (typeof SENDSTACK_RESET_TABLES)[number]),
  );
  const outOfScope = publicTables.filter(
    (table) => !SENDSTACK_RESET_TABLES.includes(table as (typeof SENDSTACK_RESET_TABLES)[number]),
  );

  console.info(
    JSON.stringify(
      {
        target: identity,
        connectedAs: inventory.identity.db_user,
        publicTableCount: publicTables.length,
        sendstackScopedTables: inScope,
        unexpectedPublicTables: outOfScope,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end();
}
