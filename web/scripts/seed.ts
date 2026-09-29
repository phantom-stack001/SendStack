import { initialEnv } from "@next/env";
import { config } from "../lib/config";
import { getPool, query } from "../lib/db";
import { hashPassword, makeId, normalizeEmail, utcNow } from "../lib/ids";

/**
 * Seeding writes sample `.test` contacts, so the target must be chosen
 * deliberately. NODE_ENV is not a safe signal: local tooling runs with
 * NODE_ENV=development while a dotenv file can still resolve a remote URL.
 */
function assertExplicitLocalTarget(): void {
  // initialEnv is @next/env's snapshot from before any dotenv file was applied,
  // so a URL that merely came from .env / .env.production does not count as injected.
  const injected = ((initialEnv ?? process.env).DATABASE_URL ?? "").trim();
  if (!injected) {
    throw new Error(
      "DATABASE_URL must be injected explicitly to seed. Refusing to seed a database chosen by a dotenv file.\n" +
        "Example: DATABASE_URL='postgresql://sendstack:sendstack@127.0.0.1:55432/sendstack_test' pnpm db:seed",
    );
  }
  if (process.argv.includes("--allow-remote")) return;
  let host = "";
  try {
    host = new URL(injected).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid postgresql:// connection string.");
  }
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  if (!local) {
    throw new Error(
      "Refusing to seed a non-local database. Seeding inserts sample contacts and must never touch a shared or production database.",
    );
  }
}

async function main() {
  assertExplicitLocalTarget();

  const now = utcNow();
  const adminEmail = normalizeEmail(config.adminEmail);
  const usingDefaultPassword = config.adminPassword === config.defaultAdminPassword;

  if (usingDefaultPassword && process.argv.includes("--allow-remote")) {
    throw new Error(
      "Refusing to seed the default admin password outside a local database. Set SENDSTACK_ADMIN_PASSWORD to a strong unique value.",
    );
  }

  const existing = await query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  if (!existing.rows[0]) {
    await query(
      `INSERT INTO users
         (id, email, name, role, password_hash, active, must_change_password, created_at, updated_at)
       VALUES ($1,$2,$3,'admin',$4,TRUE,$5,$6,$7)`,
      [
        makeId("usr"),
        adminEmail,
        "Test Administrator",
        hashPassword(config.adminPassword),
        usingDefaultPassword,
        now,
        now,
      ],
    );
    console.log(
      `Seeded admin ${adminEmail}` +
        (usingDefaultPassword ? " (must_change_password=true)" : ""),
    );
  } else {
    console.log(`Admin ${adminEmail} already exists`);
  }

  const list = await query(`SELECT id FROM lists WHERE name = $1`, ["Product updates"]);
  let listId: string;
  if (!list.rows[0]) {
    listId = makeId("lst");
    await query(`INSERT INTO lists (id, name, description, created_at) VALUES ($1,$2,$3,$4)`, [
      listId,
      "Product updates",
      "Safe sample audience for the test environment.",
      now,
    ]);
    console.log("Seeded list Product updates");
  } else {
    listId = list.rows[0].id as string;
  }

  const samples = [
    ["alex@example.test", "Alex", "Rivera"],
    ["jordan@example.test", "Jordan", "Lee"],
    ["sam@example.test", "Sam", "Nguyen"],
  ] as const;

  for (const [email, first, last] of samples) {
    const found = await query(`SELECT id FROM contacts WHERE email = $1`, [email]);
    let contactId: string;
    if (!found.rows[0]) {
      contactId = makeId("con");
      await query(
        `INSERT INTO contacts
           (id, email, first_name, last_name, consent_source, consent_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'seed',$5,$6,$7)`,
        [contactId, email, first, last, now, now, now],
      );
    } else {
      contactId = found.rows[0].id as string;
    }
    await query(
      `INSERT INTO list_contacts (list_id, contact_id, added_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [listId, contactId, now],
    );
  }

  console.log("Seed complete.");
  await getPool().end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
