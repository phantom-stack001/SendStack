import { initialEnv } from "@next/env";
import { getPool, query } from "../lib/db";
import { hashPassword, makeId, normalizeEmail, utcNow, validEmail } from "../lib/ids";

const DEFAULT_ADMIN_PASSWORD = "ChangeMe123!";

/**
 * Destructive production reset: truncate all app data, insert one admin.
 * Requires explicit CLI flags and an injected DATABASE_URL (not dotenv-only).
 */
function assertWipeAllowed(): string {
  if (!process.argv.includes("--i-understand-this-wipes-production")) {
    throw new Error(
      "Refusing to wipe. Pass --i-understand-this-wipes-production to confirm.",
    );
  }
  if (!process.argv.includes("--allow-remote")) {
    throw new Error("Refusing to wipe. Pass --allow-remote for a non-local database.");
  }

  const injected = ((initialEnv ?? process.env).DATABASE_URL ?? "").trim();
  if (!injected) {
    throw new Error(
      "DATABASE_URL must be injected explicitly on the process environment.\n" +
        "Example: DATABASE_URL='postgresql://…' SENDSTACK_ADMIN_EMAIL='…' SENDSTACK_ADMIN_PASSWORD='…' \\\n" +
        "  pnpm exec tsx scripts/reset-live-admin.ts --allow-remote --i-understand-this-wipes-production",
    );
  }

  try {
    // eslint-disable-next-line no-new
    new URL(injected);
  } catch {
    throw new Error("DATABASE_URL is not a valid postgresql:// connection string.");
  }

  // Ensure the pool uses the injected URL even if dotenv loaded a different one later.
  process.env.DATABASE_URL = injected;
  return injected;
}

function requireAdminCredentials(): { email: string; password: string } {
  const email = normalizeEmail((process.env.SENDSTACK_ADMIN_EMAIL ?? "").trim());
  const password = (process.env.SENDSTACK_ADMIN_PASSWORD ?? "").trim();
  if (!email || !validEmail(email)) {
    throw new Error("SENDSTACK_ADMIN_EMAIL must be a valid email (injected on the process env).");
  }
  if (!password || password.length < 10) {
    throw new Error("SENDSTACK_ADMIN_PASSWORD must be at least 10 characters.");
  }
  if (password === DEFAULT_ADMIN_PASSWORD) {
    throw new Error("Refusing to set the default admin password on a wiped production database.");
  }
  return { email, password };
}

async function main() {
  const databaseUrl = assertWipeAllowed();
  const host = new URL(databaseUrl).hostname;
  const { email, password } = requireAdminCredentials();

  console.log(`Wiping application tables on host=${host} …`);

  await query(`
    TRUNCATE TABLE
      launch_job_imports,
      launch_jobs,
      daily_volume_reservations,
      daily_volume_counters,
      delivery_health_blocks,
      provider_events,
      campaign_attachments,
      messages,
      campaign_recipients,
      campaigns,
      list_contacts,
      contacts,
      suppressions,
      audit_events,
      sessions,
      login_attempts,
      lists,
      users
    RESTART IDENTITY CASCADE
  `);

  const now = utcNow();
  const userId = makeId("usr");
  await query(
    `INSERT INTO users
       (id, email, name, role, password_hash, active, must_change_password, created_at, updated_at)
     VALUES ($1,$2,$3,'admin',$4,TRUE,FALSE,$5,$6)`,
    [userId, email, "Administrator", hashPassword(password), now, now],
  );

  const users = await query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM users`);
  const contacts = await query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM contacts`);
  const campaigns = await query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM campaigns`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        host,
        admin_email: email,
        admin_id: userId,
        users: Number(users.rows[0]?.count ?? 0),
        contacts: Number(contacts.rows[0]?.count ?? 0),
        campaigns: Number(campaigns.rows[0]?.count ?? 0),
      },
      null,
      2,
    ),
  );

  await getPool().end();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  try {
    await getPool().end();
  } catch {
    // ignore
  }
  process.exit(1);
});
