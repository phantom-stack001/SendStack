import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { getPool, query, resetPool } from "../lib/db";
import { hashPassword, makeId } from "../lib/ids";

/**
 * Recommended disposable Postgres URL for explicit PG suites.
 * Never used as an automatic fallback from DATABASE_URL.
 */
export const DOCUMENTED_TEST_DATABASE_URL =
  "postgresql://sendstack:sendstack@127.0.0.1:55432/sendstack_test";

const DISPOSABLE_DB_NAME = /(?:^|[_-])test(?:[_-]|$)/i;

export class PgTestSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgTestSafetyError";
  }
}

/** Parse a postgres URL and return the database name (pathname without leading /). */
export function databaseNameFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PgTestSafetyError("SENDSTACK_TEST_DATABASE_URL is not a valid URL.");
  }
  const name = decodeURIComponent((parsed.pathname || "").replace(/^\//, "")).trim();
  if (!name) {
    throw new PgTestSafetyError("SENDSTACK_TEST_DATABASE_URL must include a database name.");
  }
  return name;
}

/**
 * Positive disposable identification:
 * - DB name must contain a deliberate `_test` / `-test` / `test_` marker, OR
 * - URL query must include `sendstack_disposable=1`.
 */
export function isDisposableTestDatabaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.searchParams.get("sendstack_disposable") === "1") return true;
  const name = decodeURIComponent((parsed.pathname || "").replace(/^\//, "")).trim();
  return DISPOSABLE_DB_NAME.test(name);
}

/**
 * Resolve the dedicated test database URL.
 * NEVER falls back to DATABASE_URL. Ordinary `pnpm test` must not mutate app DBs.
 */
export function resolveTestDatabaseUrl(options?: { required?: boolean }): string | null {
  const explicit = process.env.SENDSTACK_TEST_DATABASE_URL?.trim() || "";
  if (!explicit) {
    if (options?.required) {
      throw new PgTestSafetyError(
        "SENDSTACK_TEST_DATABASE_URL is required for PostgreSQL integration/migration tests. " +
          "It never falls back to DATABASE_URL. Example: " +
          DOCUMENTED_TEST_DATABASE_URL,
      );
    }
    return null;
  }
  if (!isDisposableTestDatabaseUrl(explicit)) {
    throw new PgTestSafetyError(
      `Refusing non-disposable test database “${databaseNameFromUrl(explicit)}”. ` +
        "Name must include a _test marker (e.g. sendstack_test) or sendstack_disposable=1.",
    );
  }
  return explicit;
}

export function assertDisposableTestDatabase(url: string): void {
  if (!isDisposableTestDatabaseUrl(url)) {
    throw new PgTestSafetyError(
      `Refusing destructive PostgreSQL operation against non-disposable database “${databaseNameFromUrl(url)}”.`,
    );
  }
}

/** Probe connectivity; returns false when disposable Postgres is unavailable. */
export async function canConnectToTestDatabase(url: string): Promise<boolean> {
  if (!isDisposableTestDatabaseUrl(url)) return false;
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Apply env for PG suites. Sets DATABASE_URL to the disposable test URL only after
 * disposable identity is verified — never copies an ambient application DATABASE_URL into tests.
 */
export function applyTestEnv(url: string): void {
  assertDisposableTestDatabase(url);
  process.env.DATABASE_URL = url;
  process.env.SENDSTACK_TEST_DATABASE_URL = url;
  process.env.SENDSTACK_DAILY_LIMIT = "100000";
  process.env.SENDSTACK_DELIVERY_MODE = "sandbox";
  process.env.SENDSTACK_FROM_EMAIL = "news@example.com";
  process.env.SENDSTACK_REPLY_TO_EMAIL = "hello@example.com";
  process.env.SENDSTACK_ALLOWED_LINK_DOMAINS = "example.com,www.example.com";
  process.env.SENDSTACK_PUBLIC_URL = "https://app.example.com";
  process.env.SENDSTACK_LIVE_SEND_ENABLED = "1";
  process.env.SENDSTACK_HEALTH_MIN_SAMPLE = "1";
  process.env.SENDSTACK_HEALTH_MAX_BOUNCE_RATE = "0.5";
  process.env.SENDSTACK_HEALTH_MAX_COMPLAINT_RATE = "0.5";
  process.env.SENDSTACK_HEALTH_MAX_UNSUBSCRIBE_RATE = "0.5";
  process.env.SENDSTACK_HEALTH_MAX_DELAY_RATE = "0.5";
  process.env.SENDSTACK_HEALTH_MAX_FAILURE_RATE = "0.5";
  process.env.SENDSTACK_SMTP_HOST = process.env.SENDSTACK_SMTP_HOST || "mail.spacemail.com";
  process.env.SENDSTACK_SMTP_USERNAME = process.env.SENDSTACK_SMTP_USERNAME || "news@example.com";
  process.env.SENDSTACK_SMTP_PASSWORD = process.env.SENDSTACK_SMTP_PASSWORD || "test-smtp-password";
  delete process.env.SENDSTACK_EMERGENCY_STOP;
}

/** Apply drizzle SQL migrations without ending the shared pool. */
export async function applyMigrations(): Promise<string[]> {
  assertDisposableTestDatabase(process.env.DATABASE_URL || "");
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const dir = join(__dirname, "../drizzle");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const existing = await client.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [file]);
      if (existing.rows[0]) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (id, applied_at) VALUES ($1, NOW())`, [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    client.release();
  }
}

export async function applyMigrationFile(fileName: string): Promise<void> {
  assertDisposableTestDatabase(process.env.DATABASE_URL || "");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const existing = await client.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [fileName]);
    if (existing.rows[0]) return;
    const sql = readFileSync(join(__dirname, "../drizzle", fileName), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (id, applied_at) VALUES ($1, NOW())`, [fileName]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function wipePublicSchema(): Promise<void> {
  assertDisposableTestDatabase(process.env.DATABASE_URL || "");
  await query(`DROP SCHEMA IF EXISTS public CASCADE`);
  await query(`CREATE SCHEMA public`);
  await query(`GRANT ALL ON SCHEMA public TO CURRENT_USER`);
  await query(`GRANT ALL ON SCHEMA public TO public`);
}

export async function truncateAppTables(): Promise<void> {
  assertDisposableTestDatabase(process.env.DATABASE_URL || "");
  // Drop any leaked client locks from prior tests before truncating large row sets.
  await resetPool();
  const client = await getPool().connect();
  try {
    await client.query(`
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
  } finally {
    client.release();
  }
}

export async function ensurePgTestReady(): Promise<boolean> {
  const url = resolveTestDatabaseUrl({ required: true });
  if (!url) return false;
  const ok = await canConnectToTestDatabase(url);
  if (!ok) return false;
  applyTestEnv(url);
  await resetPool();
  await applyMigrations();
  return true;
}

const CONSENT_EVIDENCE =
  "Signed opt-in form dated 2024-01-15; verified against CRM record before activation.";

export async function seedAdminUser(email = `admin_${makeId("u")}@example.com`): Promise<string> {
  const id = makeId("usr");
  await query(
    `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at, updated_at)
     VALUES ($1, $2, 'Admin', 'admin', $3, TRUE, FALSE, NOW(), NOW())`,
    [id, email, hashPassword("TestPass123!")],
  );
  return id;
}

/** Create a session cookie + CSRF for authenticated handleApi tests. */
export async function seedAdminSession(userId?: string): Promise<{
  userId: string;
  token: string;
  csrfToken: string;
  cookie: string;
}> {
  const id = userId ?? (await seedAdminUser());
  const token = `tok_${makeId("s")}`;
  const csrfToken = `csrf_${makeId("c")}`;
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '12 hours', NOW())`,
    [tokenHash, id, csrfToken],
  );
  return {
    userId: id,
    token,
    csrfToken,
    cookie: `sendstack_session=${encodeURIComponent(token)}`,
  };
}

export async function seedList(name?: string): Promise<string> {
  const id = makeId("lst");
  await query(`INSERT INTO lists (id, name, description, created_at) VALUES ($1, $2, '', NOW())`, [
    id,
    name ?? `List ${id}`,
  ]);
  return id;
}

/** Active contact ready for campaign sends. */
export async function seedActiveContact(input: {
  listId: string;
  email: string;
  actorUserId: string;
  firstName?: string;
  lastName?: string;
}): Promise<string> {
  const id = makeId("con");
  await query(
    `INSERT INTO contacts
       (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', 'manual', NOW(), NOW(), NOW())`,
    [
      id,
      input.email.toLowerCase(),
      input.firstName ?? "Pat",
      input.lastName ?? "Lee",
    ],
  );
  await query(`INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`, [
    input.listId,
    id,
  ]);
  return id;
}

export async function seedPendingContact(input: {
  listId: string;
  email: string;
}): Promise<string> {
  const id = makeId("con");
  await query(
    `INSERT INTO contacts
       (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
     VALUES ($1, $2, 'Pending', 'User', 'pending_consent', 'csv_import', NOW(), NOW(), NOW())`,
    [id, input.email.toLowerCase()],
  );
  await query(`INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`, [
    input.listId,
    id,
  ]);
  return id;
}

export async function seedDraftCampaign(input: {
  listId: string;
  createdBy: string;
  name?: string;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
}): Promise<string> {
  const id = makeId("cam");
  await query(
    `INSERT INTO campaigns
       (id, name, subject, from_name, from_email, reply_to_email, content_mode, content_json,
        html_body, text_body, list_id, status, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'Example Co', 'news@example.com', 'hello@example.com', 'custom_html', '{}',
             $4, $5, $6, 'draft', $7, NOW(), NOW())`,
    [
      id,
      input.name ?? `Campaign ${id}`,
      input.subject ?? "March product update",
      input.htmlBody ??
        '<p>Hello {{first_name}}</p><p><a href="https://www.example.com">Visit us</a></p>',
      input.textBody ?? "Hello {{first_name}}\nVisit https://www.example.com",
      input.listId,
      input.createdBy,
    ],
  );
  return id;
}

export async function seedActiveContactsBulk(input: {
  listId: string;
  actorUserId: string;
  count: number;
  emailPrefix?: string;
}): Promise<number> {
  const prefix = input.emailPrefix ?? `bulk_${makeId("b")}`;
  const result = await query(
    `WITH generated AS (
       SELECT generate_series(1, $1::int) AS n
     ),
     inserted AS (
       INSERT INTO contacts
         (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
       SELECT 'con_' || replace(gen_random_uuid()::text, '-', ''),
              $2 || n::text || '@example.com',
              'User',
              n::text,
              'active',
              'manual',
              NOW(),
              NOW(),
              NOW()
         FROM generated
       RETURNING id
     )
     INSERT INTO list_contacts (list_id, contact_id, added_at)
     SELECT $3, id, NOW() FROM inserted
     RETURNING contact_id`,
    [input.count, prefix, input.listId],
  );
  return result.rowCount ?? 0;
}

export { CONSENT_EVIDENCE };
