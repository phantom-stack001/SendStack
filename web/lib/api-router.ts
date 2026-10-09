import { createHash, randomBytes } from "crypto";
import { json } from "./http";
import { config } from "./config";
import { getPool, query } from "./db";
import { withSubmitBarrier } from "./submit-barrier";
import {
  createContact,
  importContactStatus,
  updateContact,
} from "./consent";
import {
  consumeDailyReservation,
  releaseDailyReservation,
  reserveDailyVolume,
  usedDailyVolume,
  utcDayString,
} from "./daily-volume";
import {
  blockedHealthSnapshot,
  getDeliveryHealthSnapshot,
  listOpenDeliveryHealthBlocks,
  resolveDeliveryHealthBlock,
  waiveDeliveryHealthBlock,
} from "./delivery-health";
import { canTransitionMessageStatus, messageStatusRank } from "./delivery-status";
import { hashPassword, makeId, normalizeEmail, validEmail, verifyPassword } from "./ids";
import {
  claimAndPrepareCampaignLaunch,
  requestLaunchCancel,
  runLaunchWorkerTick,
} from "./launch-jobs";
import { DATABASE_MIGRATION_REQUIRED, DATABASE_UNAVAILABLE, redactForLog, safeClientMessage } from "./db-errors";
import { runCampaignPreflight } from "./preflight";
import { assertProductionSessionCookie, sessionCookieIsSecure } from "./env";
import { inspectSchema, summarizeSchemaReport } from "./schema-guard";
import { buildIdempotencyKey, liveSendAllowed, smtpConfigured } from "./live-send";
import { sendSmtpEmail } from "./providers/smtp";
import {
  appendToSentFolder,
  buildSentAppendSource,
  getMailboxMessage,
  listMailboxMessages,
  mailboxConfigured,
  mailboxReadAllowed,
  type MailboxFolder,
} from "./mailbox";
import { isSpecialUseRecipientDomain, validateLiveRecipient } from "./recipients";
import {
  enforcedFromEmail,
  identityComplianceGaps,
  identityConfigured,
  isTestRecipientAllowed,
  loadSendingIdentity,
} from "./sending-identity";
import { applySuppression, isEmailSuppressed, removeSuppression } from "./suppressions";
import { passwordChangeAllowedPath, requireCsrf } from "./auth";
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS, permissionsForRole, roleDefinitionsPayload } from "./rbac";
import { renderTemplate, validateEmailContent } from "./templates";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function cookieHeader(token: string, maxAge: number): string {
  if (token && maxAge > 0) assertProductionSessionCookie();
  const secure = sessionCookieIsSecure() ? "; Secure" : "";
  return `sendstack_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const IMPORT_MAX_BYTES = 1_000_000;
const IMPORT_MAX_ROWS = 5_000;
const IMPORT_MAX_FIELDS = 32;
const IMPORT_MAX_FIELD_LENGTH = 500;

async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("BODY_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    throw new Error("BAD_ENCODING");
  }
}

function trustedClientIp(request: Request): string {
  const plausible = (value: string) =>
    /^[0-9a-fA-F:.]+$/.test(value) && value.length <= 64 && value !== "unknown";
  if (process.env.VERCEL === "1") {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
      const rightmost = parts[parts.length - 1] ?? "";
      if (plausible(rightmost)) return rightmost;
    }
    const real = request.headers.get("x-real-ip")?.trim() ?? "";
    if (plausible(real)) return real;
  }
  return "unknown";
}

function hasValidCsrf(request: Request, csrfToken: string): boolean {
  return requireCsrf(request, { csrfToken }) === null;
}

function renderContactTemplate(
  value: string,
  contact: { email: string; first_name?: string; last_name?: string },
  unsubscribeUrl?: string,
): string {
  const values: Record<string, string> = {
    first_name: contact.first_name ?? "",
    last_name: contact.last_name ?? "",
    email: contact.email,
  };
  if (unsubscribeUrl) values.unsubscribe_url = unsubscribeUrl;
  return renderTemplate(value, values);
}

function templateUsesOptOut(subject: string, html: string, text: string): boolean {
  return (
    subject.includes("{{unsubscribe_url}}") ||
    html.includes("{{unsubscribe_url}}") ||
    text.includes("{{unsubscribe_url}}")
  );
}

async function currentSession(request: Request) {
  const token = cookieValue(request, "sendstack_session");
  if (!token) return null;
  const result = await query<{
    token_hash: string; csrf_token: string; user_id: string; email: string; name: string;
    role: "admin" | "marketer" | "analyst"; must_change_password: boolean;
  }>(
    `SELECT s.token_hash, s.csrf_token, u.id AS user_id, u.email, u.name, u.role, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE`,
    [tokenHash(token)],
  );
  const session = result.rows[0];
  return session ? { ...session, token } : null;
}

async function sessionPayload(session: NonNullable<Awaited<ReturnType<typeof currentSession>>>) {
  const identity = loadSendingIdentity();
  const sentToday = await usedDailyVolume();
  return {
    csrf_token: session.csrf_token,
    permissions: [...permissionsForRole(session.role)],
    delivery_mode: config.deliveryMode,
    daily_limit: config.dailyLimit,
    sent_today: sentToday,
    must_change_password: session.must_change_password,
    enforced_from_email: identity.fromEmail || null,
    reply_to_email: identity.replyToEmail || null,
    identity_configured: identityConfigured(identity),
    user: {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role,
      role_label: ROLE_DEFINITIONS[session.role]?.label ?? session.role,
      must_change_password: session.must_change_password,
    },
  };
}

async function requireSession(request: Request) {
  const session = await currentSession(request);
  return session ? { session } : { response: json(401, { error: "Not signed in." }) };
}

async function requireAdmin(request: Request) {
  const auth = await requireSession(request);
  if (auth.response) return auth;
  return auth.session.role === "admin"
    ? auth
    : { response: json(403, { error: "Administrator access is required." }) };
}

async function requirePermission(request: Request, permission: string) {
  const auth = await requireSession(request);
  if (auth.response) return auth;
  return permissionsForRole(auth.session.role).has(permission)
    ? auth
    : { response: json(403, { error: "You do not have permission to access this resource." }) };
}

function userPayload(user: { id: string; email: string; name: string; role: string; active: boolean; must_change_password: boolean; created_at: string; last_login_at?: string | null }, currentUserId: string) {
  const role = ROLE_DEFINITIONS[user.role as keyof typeof ROLE_DEFINITIONS] ?? ROLE_DEFINITIONS.analyst;
  return {
    ...user,
    role_label: role.label,
    is_current_user: user.id === currentUserId,
    last_login_at: user.last_login_at ?? null,
  };
}

function requestAuditContext(request: Request): Record<string, unknown> {
  return {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
    user_agent: request.headers.get("user-agent") ?? "unknown",
  };
}

async function recordAudit(actorUserId: string | null, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}) {
  await query(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [actorUserId, action, entityType, entityId, JSON.stringify(detail)],
  );
}

async function recordRequestAudit(request: Request, actorUserId: string | null, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}) {
  return recordAudit(actorUserId, action, entityType, entityId, { ...requestAuditContext(request), ...detail });
}

function collectEntityIds(events: Array<{ entity_type: string; entity_id: string | null }>, entityType: string): string[] {
  return [...new Set(events.filter((event) => event.entity_type === entityType && event.entity_id).map((event) => event.entity_id as string))];
}

async function loadEntityLabelMap(
  ids: string[],
  sql: string,
  pick: (row: Record<string, unknown>) => string | null,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const result = await query<Record<string, unknown>>(sql, [ids]);
  for (const row of result.rows) {
    const id = typeof row.id === "string" ? row.id : null;
    const label = pick(row);
    if (id && label) map.set(id, label);
  }
  return map;
}

function detailString(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function resolveAuditEntityLabel(
  entityType: string,
  entityId: string | null,
  detail: Record<string, unknown>,
  lookups: {
    campaign: Map<string, string>;
    list: Map<string, string>;
    contact: Map<string, string>;
    user: Map<string, string>;
    message: Map<string, string>;
  },
): string | null {
  const detailName = detailString(detail, "name");
  const detailEmail = detailString(detail, "email");

  if (entityType === "campaign") return detailName || (entityId ? lookups.campaign.get(entityId) ?? null : null);
  if (entityType === "list") return detailName || (entityId ? lookups.list.get(entityId) ?? null : null);
  if (entityType === "contact") return detailEmail || (entityId ? lookups.contact.get(entityId) ?? null : null);
  if (entityType === "user") return detailEmail || detailName || (entityId ? lookups.user.get(entityId) ?? null : null);
  if (entityType === "message") return entityId ? lookups.message.get(entityId) ?? null : null;
  if (entityType === "suppression") return entityId;
  if (entityType === "authentication") return detailEmail;
  if (entityType === "session") return null;
  if (entityType === "provider_event") {
    if (!entityId) return null;
    return entityId.length > 36 ? `${entityId.slice(0, 18)}…` : entityId;
  }
  return detailName || detailEmail;
}

async function enrichAuditEvents(events: Array<{
  id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail_json: string;
  created_at: string;
}>) {
  const parsed = events.map((event) => {
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(event.detail_json || "{}") as Record<string, unknown>;
    } catch {
      detail = {};
    }
    return { ...event, detail };
  });

  const [campaign, list, contact, user, message] = await Promise.all([
    loadEntityLabelMap(
      collectEntityIds(parsed, "campaign"),
      `SELECT id, name FROM campaigns WHERE id = ANY($1::text[])`,
      (row) => (typeof row.name === "string" && row.name.trim() ? row.name.trim() : null),
    ),
    loadEntityLabelMap(
      collectEntityIds(parsed, "list"),
      `SELECT id, name FROM lists WHERE id = ANY($1::text[])`,
      (row) => (typeof row.name === "string" && row.name.trim() ? row.name.trim() : null),
    ),
    loadEntityLabelMap(
      collectEntityIds(parsed, "contact"),
      `SELECT id, email FROM contacts WHERE id = ANY($1::text[])`,
      (row) => (typeof row.email === "string" && row.email.trim() ? row.email.trim() : null),
    ),
    loadEntityLabelMap(
      collectEntityIds(parsed, "user"),
      `SELECT id, name, email FROM users WHERE id = ANY($1::text[])`,
      (row) => {
        if (typeof row.name === "string" && row.name.trim()) return row.name.trim();
        if (typeof row.email === "string" && row.email.trim()) return row.email.trim();
        return null;
      },
    ),
    loadEntityLabelMap(
      collectEntityIds(parsed, "message"),
      `SELECT id, to_email, subject FROM messages WHERE id = ANY($1::text[])`,
      (row) => {
        if (typeof row.to_email === "string" && row.to_email.trim()) return row.to_email.trim();
        if (typeof row.subject === "string" && row.subject.trim()) return row.subject.trim();
        return null;
      },
    ),
  ]);

  const lookups = { campaign, list, contact, user, message };
  return parsed.map((event) => ({
    ...event,
    entity_label: resolveAuditEntityLabel(event.entity_type, event.entity_id, event.detail, lookups),
  }));
}

async function summaryResponse() {
  const counts = await query<{
    contacts: string;
    suppressed: string;
    queued: string;
  }>(`SELECT
      (SELECT COUNT(*) FROM contacts WHERE status = 'active') AS contacts,
      (SELECT COUNT(*) FROM suppressions) AS suppressed,
      (SELECT COUNT(*) FROM campaign_recipients WHERE status IN ('queued', 'processing', 'delayed')) AS queued`);
  const sentToday = await usedDailyVolume();
  const recentCampaigns = await query(
    `SELECT c.id, c.name, c.subject, c.status,
            COUNT(cr.id)::int AS recipients,
            COUNT(cr.id) FILTER (WHERE cr.status IN ('sent', 'delayed'))::int AS sent,
            COUNT(cr.id) FILTER (WHERE cr.status IN ('failed', 'suppressed'))::int AS issues
       FROM campaigns c
       LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 8`,
  );
  const recentMessages = await query(
    `SELECT id, to_email, subject, status, created_at
       FROM messages ORDER BY created_at DESC LIMIT 8`,
  );
  const row = counts.rows[0];
  return json(200, {
    delivery_mode: config.deliveryMode,
    daily_limit: config.dailyLimit,
    counts: {
      contacts: Number(row?.contacts ?? 0),
      suppressed: Number(row?.suppressed ?? 0),
      queued: Number(row?.queued ?? 0),
      sent_today: sentToday,
    },
    recent_campaigns: recentCampaigns.rows,
    recent_messages: recentMessages.rows,
  });
}

async function campaignById(id: string) {
  const result = await query<{
    id: string; name: string; subject: string; from_name: string; from_email: string;
    content_mode: string; content_json: string; html_body: string; text_body: string;
    list_id: string; list_name: string; status: string; created_at: string;
    launched_at: string | null; completed_at: string | null;
    reply_to_email: string | null;
    launch_lock_token: string | null;
  }>(
    `SELECT c.*, l.name AS list_name FROM campaigns c JOIN lists l ON l.id = c.list_id WHERE c.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function completeCampaignIfIdle(campaignId: string) {
  await query(
    `UPDATE campaigns
        SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE id = $1
        AND status IN ('sending', 'paused')
        AND EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.campaign_id = campaigns.id)
        AND NOT EXISTS (
          SELECT 1 FROM campaign_recipients cr
           WHERE cr.campaign_id = campaigns.id AND cr.status IN ('queued', 'processing')
        )`,
    [campaignId],
  );
}

async function readinessResponse() {
  // Catalog inspection only. Application tables that 0006/0007 add are not queried
  // until this report says the schema matches the code.
  const schema = await inspectSchema();
  const identity = loadSendingIdentity();
  const gaps = identityComplianceGaps(identity);
  const identityReady = gaps.length === 0;
  const smtpReady = smtpConfigured() && identityReady;
  const production = config.isVercelProduction || config.nodeEnv === "production";
  const health =
    schema.reachable && schema.ok
      ? await getDeliveryHealthSnapshot()
      : blockedHealthSnapshot(
          schema.reachable ? summarizeSchemaReport(schema) : "The database could not be inspected.",
        );
  const cronConfigured = Boolean((process.env.CRON_SECRET ?? "").trim());
  const readyForLive =
    production &&
    config.deliveryMode === "smtp" &&
    config.liveSendEnabled &&
    smtpReady &&
    schema.ok &&
    cronConfigured &&
    !health.launch_blocked;

  return json(200, {
    target: { platform: "Vercel", database: "Managed PostgreSQL", provider: "Spacemail SMTP" },
    current: {
      runtime: "Vercel",
      database: config.databaseUrl ? "PostgreSQL" : "Not configured",
      transport: config.deliveryMode,
      from_email: identity.fromEmail || null,
      reply_to_email: identity.replyToEmail || null,
    },
    ready_for_live_sending: readyForLive,
    health_thresholds_configured: health.thresholds_configured,
    launch_blocked: health.launch_blocked,
    blocking_reasons: health.blocking_reasons,
    schema: {
      ok: schema.ok,
      reachable: schema.reachable,
      applied_migrations: schema.applied_migrations.length,
      missing_migrations: schema.missing_migrations,
      missing_tables: schema.missing_tables,
      missing_columns: schema.missing_columns,
      missing_indexes: schema.missing_indexes,
      missing_constraints: schema.missing_constraints,
      unknown_migrations: schema.unknown_migrations,
      checksum_drift: schema.checksum_drift,
    },
    checks: [
      {
        id: "vercel_runtime",
        label: "Application runtime",
        status: production ? "ready" : "pending",
        detail: production
          ? "The application is running in the production environment."
          : "Deploy the application to the production host before enabling live email.",
      },
      {
        id: "postgres_database",
        label: "PostgreSQL database",
        status: !config.databaseUrl
          ? "not_connected"
          : !schema.reachable
            ? "unreachable"
            : schema.ok
              ? "ready"
              : "migration_required",
        detail: !config.databaseUrl
          ? "Connect the managed database and apply migrations."
          : !schema.reachable
            ? "The database could not be inspected."
            : summarizeSchemaReport(schema),
      },
      {
        id: "launch_job_cron",
        label: "Launch-job scheduler",
        status: cronConfigured ? "ready" : "not_connected",
        detail: cronConfigured
          ? "CRON_SECRET is configured; an external scheduler can authenticate launch-job ticks."
          : "CRON_SECRET is not configured, so GET /api/cron/launch-jobs fails closed and durable launches cannot progress.",
      },
      {
        id: "sender_identity",
        label: "Sender identity",
        status: identityReady ? "ready" : "pending",
        detail: identityReady
          ? `From ${identity.fromEmail}${identity.replyToEmail ? `, optional Reply-To ${identity.replyToEmail}` : ""}.`
          : `Missing: ${gaps.map((gap) => gap.label).join(", ")}.`,
      },
      {
        id: "spacemail_smtp",
        label: "Spacemail SMTP",
        status: smtpReady && config.liveSendEnabled ? "ready" : smtpReady ? "configured_locked" : "not_connected",
        detail: smtpReady && config.liveSendEnabled
          ? "Live email through Spacemail SMTP is enabled."
          : smtpReady
            ? "SMTP is configured. Live email is turned off until an administrator enables it."
            : "Set SENDSTACK_SMTP_HOST, SENDSTACK_SMTP_USERNAME, SENDSTACK_SMTP_PASSWORD, and identity settings before live email can be enabled.",
      },
      {
        id: "delivery_health",
        label: "Queue health",
        status: !health.launch_blocked ? "ready" : "pending",
        detail: !health.launch_blocked
          ? "Launch is not blocked by emergency stop or unresolved queue issues."
          : health.blocking_reasons.join(" ") || health.issues.join(" ") || "Queue health checks are incomplete.",
      },
    ],
    delivery_health: health,
    delivery_path: [
      "Create a campaign draft (From, optional Reply-To, subject, body)",
      "Pass launch preflight (subject, From, safe HTML)",
      "Verify audience suppressions and daily/hourly volume headroom",
      "Submit one recipient at a time through Spacemail SMTP (mail.spacemail.com:465)",
    ],
    volume_plan: {
      goal: `${config.dailyLimit.toLocaleString()} emails/day`,
      launch_policy:
        "Respect SENDSTACK_SMTP_HOURLY_LIMIT, SENDSTACK_DAILY_LIMIT, and the live-send kill switch. Spacemail does not report bounce or complaint webhooks.",
    },
    identity_gaps: gaps,
  });
}

export async function handleApi(request: Request, path: string[]) {
  const route = `/${path.join("/")}`;
  const schema = await inspectSchema();
  if (!schema.reachable || !schema.ok) {
    return json(503, {
      error: schema.reachable ? summarizeSchemaReport(schema) : "The database could not be inspected.",
      code: schema.reachable ? DATABASE_MIGRATION_REQUIRED : DATABASE_UNAVAILABLE,
      schema: schema.reachable
        ? {
            missing_migrations: schema.missing_migrations,
            missing_tables: schema.missing_tables,
            missing_columns: schema.missing_columns,
            unknown_migrations: schema.unknown_migrations,
            checksum_drift: schema.checksum_drift,
          }
        : undefined,
    });
  }
  if (!(request.method === "POST" && route === "/auth/login")) {
    const session = await currentSession(request);
    if (session?.must_change_password && !passwordChangeAllowedPath(`/api${route}`, request.method)) {
      return json(403, { error: "You must change your password before continuing." });
    }
  }
  if (request.method === "POST" && route === "/auth/login") {
    const clientIp = trustedClientIp(request);
    const body = await request.json().catch(() => ({})) as { email?: string; password?: string };
    const accountKey = normalizeEmail(body.email ?? "") || "unknown";
    const ACCOUNT_LIMIT = 10;
    const IP_LIMIT = 100;
    const limiter = await getPool().connect();
    let limited = false;
    try {
      await limiter.query("BEGIN");
      const lockKeys = [`login-account:${accountKey}`];
      if (clientIp !== "unknown") lockKeys.push(`login-ip:${clientIp}`);
      lockKeys.sort();
      for (const key of lockKeys) {
        await limiter.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [key]);
      }
      const recentAttempts = await limiter.query<{ account_count: string; ip_count: string }>(
        `SELECT
            COUNT(*) FILTER (WHERE account_key = $1)::int AS account_count,
            COUNT(*) FILTER (WHERE client_ip = $2 AND $2 <> 'unknown')::int AS ip_count
           FROM login_attempts
          WHERE attempted_at > NOW() - INTERVAL '5 minutes'
            AND (account_key = $1 OR (client_ip = $2 AND $2 <> 'unknown'))`,
        [accountKey, clientIp],
      );
      const accountCount = Number(recentAttempts.rows[0]?.account_count ?? 0);
      const ipCount = Number(recentAttempts.rows[0]?.ip_count ?? 0);
      if (accountCount >= ACCOUNT_LIMIT || ipCount >= IP_LIMIT) {
        limited = true;
      } else {
        const result = await limiter.query<{ id: string; email: string; name: string; role: "admin" | "marketer" | "analyst"; password_hash: string; must_change_password: boolean }>(
          `SELECT id, email, name, role, password_hash, must_change_password FROM users WHERE email = $1 AND active = TRUE`,
          [accountKey === "unknown" ? "" : accountKey],
        );
        const user = result.rows[0];
        if (!user || !body.password || !verifyPassword(body.password, user.password_hash)) {
          await limiter.query(
            `INSERT INTO login_attempts (client_ip, account_key, attempted_at) VALUES ($1, $2, NOW())`,
            [clientIp, accountKey],
          );
          await limiter.query("COMMIT");
          await recordRequestAudit(request, user?.id ?? null, "login_failed", "authentication", user?.id ?? null, {
            email: accountKey,
          });
          return json(401, { error: "Invalid email or password." });
        }
        await limiter.query(`DELETE FROM login_attempts WHERE account_key = $1`, [accountKey]);
        await limiter.query("COMMIT");
        const token = randomBytes(32).toString("base64url");
        const csrfToken = randomBytes(24).toString("base64url");
        const hours = Number(process.env.SENDSTACK_SESSION_HOURS ?? 12);
        await query(
          `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
           VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 hour'), NOW())`,
          [tokenHash(token), user.id, csrfToken, hours],
        );
        const response = json(200, await sessionPayload({ ...user, user_id: user.id, token_hash: tokenHash(token), csrf_token: csrfToken, token } as never));
        response.headers.set("Set-Cookie", cookieHeader(token, hours * 3600));
        await recordRequestAudit(request, user.id, "login_succeeded", "session", tokenHash(token), { role: user.role });
        return response;
      }
      await limiter.query("COMMIT");
    } catch (error) {
      await limiter.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      limiter.release();
    }
    if (limited) {
      return json(429, { error: "Too many login attempts. Try again shortly." });
    }
    return json(500, { error: "Login could not be completed." });
  }
  if (request.method === "GET" && route === "/session") {
    const session = await currentSession(request);
    return session ? json(200, await sessionPayload(session)) : json(401, { error: "Not signed in." });
  }
  if (request.method === "GET" && route === "/summary") {
    const auth = await requirePermission(request, "overview.view");
    if (auth.response) return auth.response;
    return summaryResponse();
  }
  if (request.method === "GET" && route === "/production-readiness") {
    const auth = await requirePermission(request, "sending.view");
    if (auth.response) return auth.response;
    return readinessResponse();
  }
  if (request.method === "GET" && route === "/delivery-health") {
    const auth = await requirePermission(request, "sending.view");
    if (auth.response) return auth.response;
    const health = await getDeliveryHealthSnapshot();
    const open_blocks = await listOpenDeliveryHealthBlocks();
    return json(200, { delivery_health: health, open_blocks });
  }
  const healthBlockMatch = route.match(/^\/delivery-health\/blocks\/([^/]+)\/(resolve|waive)$/);
  if (request.method === "POST" && healthBlockMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }
    const blockId = healthBlockMatch[1];
    const action = healthBlockMatch[2];
    const body = await request.json().catch(() => ({})) as { note?: string };
    const note = (body.note ?? "").trim();
    const result =
      action === "waive"
        ? await waiveDeliveryHealthBlock({ blockId, actorUserId: auth.session.user_id, note })
        : await resolveDeliveryHealthBlock({ blockId, actorUserId: auth.session.user_id, note });
    if (!result.ok) return json(400, { error: result.error });
    await recordRequestAudit(request, auth.session.user_id, `delivery_health_block_${action}`, "delivery_health_block", blockId, {
      note: note.slice(0, 200),
    });
    return json(200, { ok: true, id: blockId, action });
  }
  if (request.method === "GET" && route === "/lists") {
    const auth = await requirePermission(request, "lists.view");
    if (auth.response) return auth.response;
    const lists = await query(
      `SELECT l.id, l.name, l.description, l.created_at, COUNT(lc.contact_id)::int AS contact_count
         FROM lists l LEFT JOIN list_contacts lc ON lc.list_id = l.id
        GROUP BY l.id ORDER BY l.name`,
    );
    return json(200, { lists: lists.rows });
  }
  if (request.method === "POST" && route === "/lists") {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { name?: string; description?: string };
    const name = (body.name ?? "").trim();
    const description = (body.description ?? "").trim();
    if (!name) return json(400, { error: "List name is required." });
    const existing = await query(`SELECT 1 FROM lists WHERE name = $1`, [name]);
    if (existing.rows[0]) return json(409, { error: "A list with that name already exists." });
    const id = `lst_${randomBytes(16).toString("hex")}`;
    await query(`INSERT INTO lists (id, name, description, created_at) VALUES ($1, $2, $3, NOW())`, [id, name, description]);
    await recordRequestAudit(request, auth.session.user_id, "list_created", "list", id, { name });
    return json(201, { list: { id, name, description, contact_count: 0 } });
  }
  const listMatch = route.match(/^\/lists\/([^/]+)$/);
  if (request.method === "PATCH" && listMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { name?: string; description?: string };
    const name = (body.name ?? "").trim();
    if (!name) return json(400, { error: "List name is required." });
    const updated = await query(
      `UPDATE lists SET name = $1, description = $2 WHERE id = $3 RETURNING id, name, description, created_at`,
      [name, (body.description ?? "").trim(), listMatch[1]],
    );
    if (!updated.rows[0]) return json(404, { error: "List not found." });
    await recordRequestAudit(request, auth.session.user_id, "list_updated", "list", listMatch[1], { name });
    return json(200, { list: updated.rows[0] });
  }
  if (request.method === "DELETE" && listMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const deleted = await query(`DELETE FROM lists WHERE id = $1 RETURNING id`, [listMatch[1]]);
    if (!deleted.rows[0]) return json(404, { error: "List not found." });
    await recordRequestAudit(request, auth.session.user_id, "list_deleted", "list", listMatch[1]);
    return json(200, { ok: true });
  }
  if (request.method === "GET" && route === "/users") {
    const auth = await requirePermission(request, "users.view");
    if (auth.response) return auth.response;
    const users = await query<{
      id: string; email: string; name: string; role: string; active: boolean;
      must_change_password: boolean; created_at: string; last_login_at: string | null;
    }>(`SELECT u.id, u.email, u.name, u.role, u.active, u.must_change_password, u.created_at,
               MAX(a.created_at) FILTER (WHERE a.action = 'login_succeeded') AS last_login_at
          FROM users u
          LEFT JOIN audit_events a ON a.actor_user_id = u.id
         GROUP BY u.id
         ORDER BY u.created_at`);
    return json(200, {
      users: users.rows.map((user) => userPayload(user, auth.session.user_id)),
      roles: roleDefinitionsPayload(),
      permissions: PERMISSION_DEFINITIONS,
    });
  }
  if (request.method === "GET" && route === "/suppressions") {
    const auth = await requirePermission(request, "suppressions.view");
    if (auth.response) return auth.response;
    const suppressions = await query(
      `SELECT email, reason, source, created_at FROM suppressions ORDER BY created_at DESC LIMIT 500`,
    );
    return json(200, { suppressions: suppressions.rows });
  }
  if (request.method === "GET" && route === "/audit") {
    const auth = await requirePermission(request, "audit.view");
    if (auth.response) return auth.response;
    const params = new URL(request.url).searchParams;
    const actionFilter = params.get("action")?.trim() ?? "";
    const entityFilter = params.get("entity_type")?.trim() ?? "";
    const q = params.get("q")?.trim() ?? "";
    const from = params.get("from")?.trim() ?? "";
    const to = params.get("to")?.trim() ?? "";
    const limit = Math.min(Math.max(Number(params.get("limit") ?? 500) || 500, 1), 1000);
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !datePattern.test(from)) || (to && !datePattern.test(to))) {
      return json(400, { error: "Dates must be YYYY-MM-DD." });
    }
    if (from && to && from > to) {
      return json(400, { error: "Start date must be on or before end date." });
    }

    const values: unknown[] = [];
    const where: string[] = [];
    if (actionFilter) {
      values.push(actionFilter);
      where.push(`a.action = $${values.length}`);
    }
    if (entityFilter) {
      values.push(entityFilter);
      where.push(`a.entity_type = $${values.length}`);
    }
    if (q) {
      values.push(q);
      const idx = values.length;
      where.push(
        `(COALESCE(u.name, '') ILIKE '%' || $${idx} || '%' OR a.action ILIKE '%' || $${idx} || '%' OR a.entity_type ILIKE '%' || $${idx} || '%' OR COALESCE(a.entity_id, '') ILIKE '%' || $${idx} || '%' OR a.detail_json ILIKE '%' || $${idx} || '%')`,
      );
    }
    if (from) {
      values.push(from);
      where.push(`a.created_at >= $${values.length}::date`);
    }
    if (to) {
      values.push(to);
      where.push(`a.created_at < ($${values.length}::date + interval '1 day')`);
    }

    values.push(limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const events = await query<{
      id: string; actor_user_id: string | null; actor_name: string | null; action: string;
      entity_type: string; entity_id: string | null; detail_json: string; created_at: string;
    }>(
      `SELECT a.id, a.actor_user_id, u.name AS actor_name, a.action, a.entity_type,
              a.entity_id, a.detail_json, a.created_at
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
         ${whereSql}
        ORDER BY a.created_at DESC LIMIT $${values.length}`,
      values,
    );
    return json(200, {
      events: await enrichAuditEvents(events.rows),
      filters: {
        action: actionFilter || null,
        entity_type: entityFilter || null,
        q: q || null,
        from: from || null,
        to: to || null,
      },
    });
  }
  if (request.method === "POST" && route === "/suppressions") {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { email?: string; reason?: string };
    const email = normalizeEmail(body.email ?? "");
    if (!validEmail(email)) return json(400, { error: "Enter a valid email address." });
    if (body.reason !== "manual") return json(400, { error: "Manual suppressions must use the manual reason." });
    await applySuppression(email, "manual", "application");
    await recordRequestAudit(request, auth.session.user_id, "suppression_created", "suppression", email, { reason: "manual" });
    return json(201, { suppression: { email, reason: "manual", source: "application" } });
  }
  const suppressionMatch = route.match(/^\/suppressions\/([^/]+)$/);
  if (request.method === "DELETE" && suppressionMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const email = normalizeEmail(decodeURIComponent(suppressionMatch[1]));
    try {
      const result = await removeSuppression({
        email,
        actorUserId: auth.session.user_id,
      });
      if (!result.removed) return json(404, { error: "Suppression not found." });
      return json(200, {
        ok: true,
        provider_reactivated: false,
        resulting_status: "active",
        previous_reason: result.previousReason ?? null,
        previous_source: result.previousSource ?? null,
      });
    } catch (error) {
      return json(400, { error: safeClientMessage(error, "Could not remove suppression.") });
    }
  }
  if (request.method === "POST" && route === "/users") {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { name?: string; email?: string; role?: string; password?: string };
    const name = (body.name ?? "").trim();
    const email = normalizeEmail(body.email ?? "");
    const role = body.role ?? "marketer";
    if (!name || !validEmail(email)) return json(400, { error: "Enter a name and valid email address." });
    if (!(role in ROLE_DEFINITIONS)) return json(400, { error: "Select a valid role." });
    if (!body.password || body.password.length < 12) return json(400, { error: "Password must be at least 12 characters." });
    const existing = await query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    if (existing.rows[0]) return json(409, { error: "That email address already exists." });
    const id = `usr_${randomBytes(16).toString("hex")}`;
    await query(
      `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, NOW(), NOW())`,
      [id, email, name, role, hashPassword(body.password)],
    );
    await recordRequestAudit(request, auth.session.user_id, "user_created", "user", id, { email, role });
    return json(201, { user: userPayload({ id, email, name, role, active: true, must_change_password: true, created_at: new Date().toISOString() }, auth.session.user_id) });
  }
  const userMatch = route.match(/^\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    if (userMatch[1] === auth.session.user_id) return json(400, { error: "Another administrator must change your own access." });
    const body = await request.json().catch(() => ({})) as { name?: string; email?: string; role?: string; active?: boolean };
    const name = (body.name ?? "").trim();
    const email = normalizeEmail(body.email ?? "");
    if (!name || !validEmail(email)) return json(400, { error: "Enter a name and valid email address." });
    if (!body.role || !(body.role in ROLE_DEFINITIONS)) return json(400, { error: "Select a valid role." });
    const updated = await query(
      `UPDATE users SET name = $1, email = $2, role = $3, active = $4, updated_at = NOW()
       WHERE id = $5 RETURNING id, email, name, role, active, must_change_password, created_at`,
      [name, email, body.role, body.active !== false, userMatch[1]],
    );
    if (!updated.rows[0]) return json(404, { error: "User not found." });
    await query(`DELETE FROM sessions WHERE user_id = $1`, [userMatch[1]]);
    await recordRequestAudit(request, auth.session.user_id, "user_access_updated", "user", userMatch[1], { email, role: body.role, active: body.active !== false });
    return json(200, { user: userPayload(updated.rows[0] as never, auth.session.user_id) });
  }
  if (request.method === "DELETE" && userMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    if (userMatch[1] === auth.session.user_id) return json(400, { error: "You cannot delete your own account." });
    const deleted = await query(`DELETE FROM users WHERE id = $1 RETURNING id`, [userMatch[1]]);
    if (!deleted.rows[0]) return json(404, { error: "User not found." });
    await recordRequestAudit(request, auth.session.user_id, "user_deleted", "user", userMatch[1]);
    return json(200, { ok: true });
  }
  const resetMatch = route.match(/^\/users\/([^/]+)\/reset-password$/);
  if (request.method === "POST" && resetMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as { password?: string };
    if (!body.password || body.password.length < 12) return json(400, { error: "Password must be at least 12 characters." });
    const updated = await query(`UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = NOW() WHERE id = $2 RETURNING id`, [hashPassword(body.password), resetMatch[1]]);
    if (!updated.rows[0]) return json(404, { error: "User not found." });
    await query(`DELETE FROM sessions WHERE user_id = $1`, [resetMatch[1]]);
    await recordRequestAudit(request, auth.session.user_id, "user_password_reset", "user", resetMatch[1]);
    return json(200, { ok: true });
  }
  if (request.method === "GET" && route === "/contacts") {
    const auth = await requirePermission(request, "contacts.view");
    if (auth.response) return auth.response;
    const params = new URL(request.url).searchParams;
    const search = params.get("q")?.trim() ?? "";
    const listId = params.get("list_id")?.trim() ?? "";
    if (listId) {
      const list = await query(`SELECT id FROM lists WHERE id = $1`, [listId]);
      if (!list.rows[0]) return json(400, { error: "The selected list does not exist." });
    }
    const contacts = await query(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.status, c.consent_source,
              c.created_at,
              STRING_AGG(l.name, ', ' ORDER BY l.name) AS lists,
              COALESCE(ARRAY_AGG(l.id ORDER BY l.name) FILTER (WHERE l.id IS NOT NULL), '{}') AS list_ids
         FROM contacts c
         LEFT JOIN list_contacts lc ON lc.contact_id = c.id
         LEFT JOIN lists l ON l.id = lc.list_id
        WHERE ($1 = '' OR c.email ILIKE '%' || $1 || '%' OR c.first_name ILIKE '%' || $1 || '%' OR c.last_name ILIKE '%' || $1 || '%')
          AND ($2 = '' OR EXISTS (
                SELECT 1 FROM list_contacts membership
                 WHERE membership.contact_id = c.id AND membership.list_id = $2
              ))
        GROUP BY c.id ORDER BY c.created_at DESC LIMIT 500`,
      [search, listId],
    );
    return json(200, { contacts: contacts.rows, list_id: listId || null });
  }
  if (request.method === "POST" && route === "/contacts/import") {
    const auth = await requirePermission(request, "contacts.manage");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });

    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return json(415, { error: "Content-Type must be application/json." });
    }
    let rawBody = "";
    try {
      rawBody = await readBoundedBody(request, IMPORT_MAX_BYTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "BODY_TOO_LARGE") return json(413, { error: "Import body exceeds the size limit." });
      if (message === "BAD_ENCODING") return json(400, { error: "Import body must be valid UTF-8." });
      throw error;
    }
    let body: { csv_text?: string; list_id?: string };
    try {
      body = JSON.parse(rawBody) as { csv_text?: string; list_id?: string };
    } catch {
      return json(400, { error: "Import body must be JSON." });
    }
    const csvText = body.csv_text ?? "";
    const listId = body.list_id ?? "";
    if (!csvText.trim()) return json(400, { error: "Upload a CSV file." });
    if (!listId) return json(400, { error: "Select a destination list." });
    const list = await query(`SELECT id FROM lists WHERE id = $1`, [listId]);
    if (!list.rows[0]) return json(400, { error: "The selected list does not exist." });

    const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) return json(400, { error: "CSV must include a header row and at least one contact." });

    const parseCsvLine = (line: string): string[] => {
      const cells: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i += 1;
          } else {
            inQuotes = !inQuotes;
          }
          continue;
        }
        if (char === "," && !inQuotes) {
          cells.push(current.trim());
          current = "";
          continue;
        }
        current += char;
      }
      cells.push(current.trim());
      return cells;
    };

    if (lines.length - 1 > IMPORT_MAX_ROWS) {
      return json(413, { error: "CSV exceeds the row limit." });
    }
    const headers = parseCsvLine(lines[0]).map((header) => header.trim().toLowerCase().replace(/\s+/g, "_"));
    if (headers.length > IMPORT_MAX_FIELDS) {
      return json(400, { error: "CSV exceeds the field limit." });
    }
    const emailIndex = headers.indexOf("email");
    if (emailIndex < 0) return json(400, { error: "CSV must include an email column." });
    const firstNameIndex = headers.indexOf("first_name");
    const lastNameIndex = headers.indexOf("last_name");

    let imported = 0;
    let updated = 0;
    let duplicates = 0;
    let invalid = 0;
    const issues: Array<{ row: number; email: string; reason: string }> = [];
    let issuesTruncated = false;
    const ISSUE_CAP = 100;
    const pushIssue = (row: number, email: string, reason: string) => {
      if (issues.length >= ISSUE_CAP) {
        issuesTruncated = true;
        return;
      }
      issues.push({ row, email, reason });
    };
    const seenInFile = new Set<string>();
    const importClient = await getPool().connect();
    try {
    await importClient.query("BEGIN");

    for (let index = 1; index < lines.length; index += 1) {
      const row = index + 1;
      const cells = parseCsvLine(lines[index]);
      if (cells.length > IMPORT_MAX_FIELDS || cells.some((cell) => cell.length > IMPORT_MAX_FIELD_LENGTH)) {
        invalid += 1;
        pushIssue(row, "", "field_too_long");
        continue;
      }
      const rawEmail = (cells[emailIndex] ?? "").trim();
      const email = normalizeEmail(rawEmail);
      if (!validEmail(email)) {
        invalid += 1;
        pushIssue(row, rawEmail || email, "invalid_email");
        continue;
      }
      if (seenInFile.has(email)) {
        duplicates += 1;
        pushIssue(row, email, "duplicate_in_file");
        continue;
      }
      seenInFile.add(email);

      const firstName = firstNameIndex >= 0 ? (cells[firstNameIndex] ?? "").trim() : "";
      const lastName = lastNameIndex >= 0 ? (cells[lastNameIndex] ?? "").trim() : "";
      const existing = await importClient.query<{ id: string }>(`SELECT id FROM contacts WHERE email = $1`, [email]);
      if (existing.rows[0]) {
        const contactId = existing.rows[0].id;
        await importClient.query(
          `UPDATE contacts SET first_name = CASE WHEN $1 = '' THEN first_name ELSE $1 END,
             last_name = CASE WHEN $2 = '' THEN last_name ELSE $2 END, updated_at = NOW()
           WHERE id = $3`,
          [firstName, lastName, contactId],
        );
        await importClient.query(
          `INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())
           ON CONFLICT (list_id, contact_id) DO NOTHING`,
          [listId, contactId],
        );
        updated += 1;
        continue;
      }

      const id = `con_${randomBytes(16).toString("hex")}`;
      const suppressed = await importClient.query(`SELECT 1 FROM suppressions WHERE email = $1`, [email]);
      const status = importContactStatus(Boolean(suppressed.rows[0]));
      await importClient.query(
        `INSERT INTO contacts
           (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'csv_import', NOW(), NOW(), NOW())`,
        [id, email, firstName, lastName, status],
      );
      await importClient.query(
        `INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`,
        [listId, id],
      );
      imported += 1;
    }

    await importClient.query("COMMIT");
    await recordRequestAudit(request, auth.session.user_id, "contacts_imported", "list", listId, {
      imported,
      updated,
      duplicates,
      invalid,
    });
    return json(200, { imported, updated, duplicates, invalid, issues, issues_truncated: issuesTruncated });
    } catch (error) {
      await importClient.query("ROLLBACK").catch(() => undefined);
      await recordRequestAudit(request, auth.session.user_id, "contacts_import_failed", "list", listId, {
        error: safeClientMessage(error, "Import failed."),
      }).catch(() => undefined);
      return json(500, { error: safeClientMessage(error, "Import failed.") });
    } finally {
      importClient.release();
    }
  }
  const contactMatch = route.match(/^\/contacts\/([^/]+)$/);
  if (request.method === "GET" && contactMatch) {
    const auth = await requirePermission(request, "contacts.view");
    if (auth.response) return auth.response;

    const contact = await query(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.status, c.consent_source,
              c.consent_at, c.created_at, c.updated_at,
              STRING_AGG(l.name, ', ' ORDER BY l.name) AS lists,
              COALESCE(ARRAY_AGG(l.id ORDER BY l.name) FILTER (WHERE l.id IS NOT NULL), '{}') AS list_ids
         FROM contacts c
         LEFT JOIN list_contacts lc ON lc.contact_id = c.id
         LEFT JOIN lists l ON l.id = lc.list_id
        WHERE c.id = $1
        GROUP BY c.id`,
      [contactMatch[1]],
    );
    if (!contact.rows[0]) return json(404, { error: "Contact not found." });

    const row = contact.rows[0] as {
      id: string;
      email: string;
      first_name: string;
      last_name: string;
      status: string;
      consent_source: string;
      consent_at: string;
      created_at: string;
      updated_at: string;
      lists: string | null;
      list_ids: string[];
    };

    const suppression = await query<{ reason: string; source: string; created_at: string }>(
      `SELECT reason, source, created_at FROM suppressions WHERE email = $1`,
      [row.email],
    );
    const messages = await query(
      `SELECT m.id, m.subject, m.status, m.created_at, m.campaign_id, c.name AS campaign_name
         FROM messages m
         LEFT JOIN campaigns c ON c.id = m.campaign_id
        WHERE m.contact_id = $1
        ORDER BY m.created_at DESC
        LIMIT 50`,
      [row.id],
    );

    return json(200, {
      contact: row,
      suppression: suppression.rows[0] ?? null,
      messages: messages.rows,
    });
  }
  if (request.method === "PATCH" && contactMatch) {
    const auth = await requirePermission(request, "contacts.edit");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const body = await request.json().catch(() => ({})) as {
      email?: string;
      status?: string;
      list_id?: string;
    };
    const email = normalizeEmail(body.email ?? "");
    if (!validEmail(email)) return json(400, { error: "Enter a valid email address." });
    const nextStatus = body.status?.trim() || undefined;
    if (nextStatus && !["active", "suppressed"].includes(nextStatus)) {
      return json(400, { error: "Select a valid contact status (active or suppressed)." });
    }

    try {
      const contact = await updateContact({
        contactId: contactMatch[1],
        actorUserId: auth.session.user_id,
        email,
        status: nextStatus as "active" | "suppressed" | undefined,
        listId: body.list_id ?? null,
      });
      return json(200, { contact });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      return json(status, { error: safeClientMessage(error, "Contact update failed.") });
    }
  }
  if (request.method === "DELETE" && contactMatch) {
    const auth = await requirePermission(request, "contacts.edit");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    try {
      const deleted = await query(`DELETE FROM contacts WHERE id = $1 RETURNING id`, [contactMatch[1]]);
      if (!deleted.rows[0]) return json(404, { error: "Contact not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/foreign key|violates/i.test(message)) {
        return json(409, { error: "This contact is still linked to campaign history and cannot be deleted yet." });
      }
      throw error;
    }
    await recordRequestAudit(request, auth.session.user_id, "contact_deleted", "contact", contactMatch[1]);
    return json(200, { ok: true });
  }
  if (request.method === "GET" && route === "/campaigns") {
    const auth = await requirePermission(request, "campaigns.view");
    if (auth.response) return auth.response;
    const campaigns = await query(
      `SELECT c.id, c.name, c.subject, c.from_name, c.from_email, c.content_mode,
              c.status, c.created_at, l.name AS list_name,
              COUNT(cr.id)::int AS recipients,
              COUNT(cr.id) FILTER (WHERE cr.status = 'queued')::int AS queued,
              COUNT(cr.id) FILTER (WHERE cr.status = 'sent')::int AS submitted,
              COUNT(cr.id) FILTER (WHERE cr.status = 'sent')::int AS sent,
              COUNT(cr.id) FILTER (WHERE cr.status = 'failed')::int AS failed
         FROM campaigns c JOIN lists l ON l.id = c.list_id
         LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
        GROUP BY c.id, l.name ORDER BY c.created_at DESC`,
    );
    return json(200, { campaigns: campaigns.rows });
  }
  if (request.method === "POST" && route === "/campaigns") {
    const auth = await requirePermission(request, "campaigns.manage");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }

    const body = await request.json().catch(() => ({})) as {
      name?: string;
      list_id?: string;
      from_name?: string;
      from_email?: string;
      subject?: string;
      content_mode?: string;
      content_json?: unknown;
      html_body?: string;
      text_body?: string;
    };
    const identity = loadSendingIdentity();
    const name = (body.name ?? "").trim();
    const listId = body.list_id ?? "";
    const fromName = (body.from_name ?? "").trim();
    const requestedFrom = normalizeEmail(body.from_email ?? identity.fromEmail);
    const fromEmail = identity.fromEmail || requestedFrom;
    const subject = (body.subject ?? "").trim();
    const contentMode = body.content_mode ?? "custom_html";
    const validModes = ["visual", "rich_text", "custom_html", "plain_text"];
    if (!name || !fromName || !subject) return json(400, { error: "Name, sender, and subject are required." });
    if (!validEmail(fromEmail)) return json(400, { error: "Enter a valid sender email address." });
    if (identity.fromEmail && fromEmail !== identity.fromEmail) {
      return json(400, { error: `From address must be ${identity.fromEmail}.` });
    }
    if (!listId) return json(400, { error: "Select an audience list." });
    if (!validModes.includes(contentMode)) return json(400, { error: "Select a valid message format." });
    const list = await query(`SELECT id FROM lists WHERE id = $1`, [listId]);
    if (!list.rows[0]) return json(400, { error: "The selected list does not exist." });

    try {
      validateEmailContent(body.html_body ?? "", body.text_body ?? "");
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : "Campaign content is invalid." });
    }

    let contentJson = "{\"schema_version\":1}";
    if (body.content_json) {
      try {
        const parsedContent = typeof body.content_json === "string"
          ? JSON.parse(body.content_json)
          : body.content_json;
        contentJson = JSON.stringify(parsedContent);
      } catch {
        return json(400, { error: "Campaign content is invalid." });
      }
    }
    const id = `cam_${randomBytes(16).toString("hex")}`;
    await query(
      `INSERT INTO campaigns
         (id, name, subject, from_name, from_email, reply_to_email, content_mode, content_json, html_body, text_body,
          list_id, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, NOW(), NOW())`,
      [
        id,
        name,
        subject,
        fromName,
        fromEmail,
        identity.replyToEmail || null,
        contentMode,
        contentJson,
        body.html_body ?? "",
        body.text_body ?? "",
        listId,
        auth.session.user_id,
      ],
    );
    await recordRequestAudit(request, auth.session.user_id, "campaign_created", "campaign", id, { name, list_id: listId, content_mode: contentMode });
    return json(201, { campaign: { id, name, subject, status: "draft", list_id: listId } });
  }
  const campaignMatch = route.match(/^\/campaigns\/([^/]+)$/);
  if (request.method === "GET" && campaignMatch) {
    const auth = await requirePermission(request, "campaigns.view");
    if (auth.response) return auth.response;
    const campaign = await campaignById(campaignMatch[1]);
    if (!campaign) return json(404, { error: "Campaign not found." });
    const stats = await query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::int AS count FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status`,
      [campaign.id],
    );
    const eligible = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
         FROM contacts c JOIN list_contacts lc ON lc.contact_id = c.id
        WHERE lc.list_id = $1 AND c.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`,
      [campaign.list_id],
    );
    return json(200, {
      campaign: {
        ...campaign,
        stats: Object.fromEntries(stats.rows.map((row) => [row.status, row.count])),
        eligible_recipients: Number(eligible.rows[0]?.count ?? 0),
      },
    });
  }
  if (request.method === "PATCH" && campaignMatch) {
    const auth = await requirePermission(request, "campaigns.manage");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const existing = await campaignById(campaignMatch[1]);
    if (!existing) return json(404, { error: "Editable campaign not found." });
    if (existing.status === "paused") {
      if (!permissionsForRole(auth.session.role).has("campaigns.send")) {
        return json(403, { error: "Only an administrator can edit a paused campaign." });
      }
    } else if (existing.status !== "draft") {
      return json(409, { error: "Only draft or paused campaigns can be edited." });
    }
    const identity = loadSendingIdentity();
    const body = await request.json().catch(() => ({})) as { name?: string; subject?: string; from_name?: string; from_email?: string; list_id?: string; content_mode?: string; content_json?: unknown; html_body?: string; text_body?: string };
    const name = (body.name ?? "").trim();
    const fromEmail = normalizeEmail(body.from_email ?? identity.fromEmail);
    if (!name || !(body.subject ?? "").trim() || !(body.from_name ?? "").trim()) return json(400, { error: "Name, sender, and subject are required." });
    if (!validEmail(fromEmail)) return json(400, { error: "Enter a valid sender email address." });
    if (identity.fromEmail && fromEmail !== identity.fromEmail) {
      return json(400, { error: `From address must be ${identity.fromEmail}.` });
    }
    const contentJson = typeof body.content_json === "string" ? body.content_json : JSON.stringify(body.content_json ?? { schema_version: 1 });
    try { JSON.parse(contentJson); } catch { return json(400, { error: "Campaign content is invalid." }); }
    try {
      validateEmailContent(body.html_body ?? "", body.text_body ?? "");
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : "Campaign content is invalid." });
    }
    const updated = await query(
      `UPDATE campaigns SET name = $1, subject = $2, from_name = $3, from_email = $4, reply_to_email = $5, list_id = $6,
       content_mode = $7, content_json = $8, html_body = $9, text_body = $10, updated_at = NOW()
       WHERE id = $11 AND status = $12 RETURNING id, name, subject, status, list_id`,
      [
        name,
        (body.subject ?? "").trim(),
        (body.from_name ?? "").trim(),
        fromEmail,
        identity.replyToEmail || null,
        body.list_id,
        body.content_mode ?? "custom_html",
        contentJson,
        body.html_body ?? "",
        body.text_body ?? "",
        campaignMatch[1],
        existing.status,
      ],
    );
    if (!updated.rows[0]) return json(409, { error: "Campaign could not be updated." });
    await recordRequestAudit(request, auth.session.user_id, "campaign_updated", "campaign", campaignMatch[1], { name, list_id: body.list_id });
    return json(200, { campaign: updated.rows[0] });
  }
  if (request.method === "DELETE" && campaignMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const deleted = await query(`DELETE FROM campaigns WHERE id = $1 AND status = 'draft' RETURNING id`, [campaignMatch[1]]);
    if (!deleted.rows[0]) return json(409, { error: "Only draft campaigns can be deleted." });
    await recordRequestAudit(request, auth.session.user_id, "campaign_deleted", "campaign", campaignMatch[1]);
    return json(200, { ok: true });
  }
  const campaignAction = route.match(/^\/campaigns\/([^/]+)\/(test-send|launch|pause|resume)$/);
  if (request.method === "POST" && campaignAction) {
    // Live test sends are restricted to administrators (campaigns.send).
    const actionPermission = "campaigns.send";
    const auth = await requirePermission(request, actionPermission);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const campaign = await campaignById(campaignAction[1]);
    if (!campaign) return json(404, { error: "Campaign not found." });
    const body = await request.json().catch(() => ({})) as { email?: string; attempt_id?: string };
    const targetEmail = normalizeEmail(body.email ?? "");
    const identity = loadSendingIdentity();
    const isTestSend = campaignAction[2] === "test-send";
    const isLive = config.deliveryMode === "smtp" && liveSendAllowed();
    const isSmtpLaunch = campaignAction[2] === "launch" && config.deliveryMode === "smtp";

    if (campaignAction[2] === "pause") {
      if (!["sending", "submission_unknown", "cancel_requested"].includes(campaign.status)) {
        return json(409, { error: "Only sending campaigns can be paused or cancelled." });
      }
      try {
        const cancel = await requestLaunchCancel(campaign.id);
        await recordRequestAudit(request, auth.session.user_id, "campaign_cancel_requested", "campaign", campaign.id, {
          status: cancel.campaignStatus,
          provider_cancelled: cancel.providerCancelled,
          error: cancel.error ?? null,
        });
        if (cancel.error && cancel.providerCancelled === false) {
          return json(409, {
            error: `Spacemail cannot recall mail it already accepted. Only unsent recipients can be stopped: ${cancel.error}`,
            status: cancel.campaignStatus,
            provider_cancelled: false,
            cancellable: false,
          });
        }
        return json(200, {
          ok: true,
          status: cancel.campaignStatus,
          provider_cancelled: cancel.providerCancelled,
        });
      } catch (error) {
        return json(400, { error: safeClientMessage(error, "Cancel request failed.") });
      }
    }

    if (campaignAction[2] === "resume") {
      if (campaign.status !== "paused") {
        return json(409, { error: "Only paused campaigns can be resumed." });
      }
      await query(`UPDATE campaigns SET status = 'draft', updated_at = NOW() WHERE id = $1`, [campaign.id]);
      await recordRequestAudit(request, auth.session.user_id, "campaign_resumed", "campaign", campaign.id, { status: "draft" });
      return json(200, { ok: true, status: "draft" });
    }

    if (isTestSend) {
      if (!validEmail(targetEmail)) return json(400, { error: "Enter a valid test recipient email." });
      if (isSpecialUseRecipientDomain(targetEmail)) {
        return json(400, { error: "Special-use domains cannot receive test email." });
      }
      if (["1", "true", "yes", "on"].includes((process.env.SENDSTACK_EMERGENCY_STOP ?? "").trim().toLowerCase())) {
        return json(403, { error: "SENDSTACK_EMERGENCY_STOP is enabled." });
      }
      if (isLive) {
        if (!identityConfigured(identity)) {
          return json(403, { error: "Sender identity settings are required before live test sends." });
        }
        if (!isTestRecipientAllowed(targetEmail, identity)) {
          return json(403, { error: "Test recipient is not on SENDSTACK_TEST_RECIPIENT_ALLOWLIST." });
        }
      }
      if (await isEmailSuppressed(targetEmail)) {
        return json(403, { error: "That address is suppressed and cannot receive test email." });
      }

      let fromEmail = campaign.from_email;
      // Reply-To only when the campaign sets one — not from SENDSTACK_REPLY_TO_EMAIL.
      let replyTo = campaign.reply_to_email || undefined;
      if (isLive) {
        try {
          fromEmail = enforcedFromEmail(campaign.from_email, identity);
        } catch (error) {
          return json(403, { error: error instanceof Error ? error.message : "Sender identity is not configured." });
        }
      }

      const authoredHtml = campaign.html_body ?? "";
      const authoredText = campaign.text_body ?? "";
      const usesOptOut = templateUsesOptOut(campaign.subject, authoredHtml, authoredText);

      const preflight = runCampaignPreflight({
        subject: campaign.subject,
        htmlBody: authoredHtml,
        textBody: authoredText,
        fromEmail: campaign.from_email,
        fromName: campaign.from_name,
        identity,
        requirePublicHttps: isLive && usesOptOut,
      });
      if (!preflight.ok) {
        return json(400, { error: preflight.errors[0], errors: preflight.errors });
      }

      // A retry reuses the open attempt. It must not mint a new idempotency key.
      const bodyAttempt = body.attempt_id?.trim();
      const openAttempt = (
        await query<{
          id: string;
          idempotency_key: string | null;
          volume_reservation_id: string | null;
          status: string;
          provider_id: string | null;
          created_at: string;
        }>(
          `SELECT id, idempotency_key, volume_reservation_id, status, provider_id, created_at
             FROM messages
            WHERE campaign_id = $1 AND lower(to_email) = $2 AND COALESCE(is_test, FALSE) = TRUE
              AND ($3::text IS NULL OR idempotency_key LIKE $3)
              AND status IN ('captured', 'submission_unknown', 'submitted')
            ORDER BY created_at DESC LIMIT 1`,
          [campaign.id, targetEmail, bodyAttempt ? `%:${bodyAttempt}` : null],
        )
      ).rows[0];
      if (bodyAttempt && (!openAttempt || !["captured", "submission_unknown", "submitted"].includes(openAttempt.status))) {
        return json(409, {
          error: "attempt_id must identify the open test message for this campaign and recipient.",
          attempt_id: bodyAttempt,
          found_status: openAttempt?.status ?? null,
        });
      }
      if (openAttempt?.provider_id || openAttempt?.status === "submitted") {
        return json(200, {
          queued: 1,
          sent: 1,
          failed: 0,
          attempt_id: bodyAttempt || openAttempt.idempotency_key?.split(":").pop() || openAttempt.id,
          status: "submitted",
        });
      }
      if (openAttempt && Date.now() - new Date(openAttempt.created_at).getTime() > 24 * 60 * 60 * 1000) {
        return json(409, {
          error: "The provider idempotency window for this attempt has expired. Confirm delivery before sending again.",
          attempt_id: bodyAttempt || openAttempt.id,
          status: "manual_review",
        });
      }
      const existingUnknown = openAttempt ?? null;
      const attemptId = bodyAttempt || existingUnknown?.idempotency_key?.split(":").pop() || makeId("tatt");
      const reservationKey = `test:${campaign.id}:${targetEmail}:${attemptId}`;
      const reserved = existingUnknown?.volume_reservation_id
        ? { ok: true as const, reservationId: existingUnknown.volume_reservation_id }
        : await reserveDailyVolume({
            reservationKey,
            campaignId: campaign.id,
          });
      if (!reserved.ok) {
        return json(429, { error: reserved.error, used: reserved.used, limit: reserved.limit });
      }

      const contact = { id: null as string | null, email: targetEmail, first_name: "Test", last_name: "Recipient" };
      const messageId = existingUnknown?.id || makeId("msg");
      const unsubscribeToken = usesOptOut ? randomBytes(24).toString("base64url") : null;
      const unsubscribeUrl = unsubscribeToken ? `${config.publicUrl}/u/${unsubscribeToken}` : undefined;
      const htmlBody = renderContactTemplate(authoredHtml, contact, unsubscribeUrl);
      const textBody = renderContactTemplate(authoredText, contact, unsubscribeUrl);
      const subject = renderContactTemplate(`[TEST] ${campaign.subject}`, contact, unsubscribeUrl);
      const idempotencyKey =
        existingUnknown?.idempotency_key || buildIdempotencyKey(["test", campaign.id, targetEmail, attemptId]);

      await query(
        `INSERT INTO messages
           (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email, reply_to_email,
            html_body, text_body, status, unsubscribe_token, created_at, idempotency_key, diagnostic_json,
            is_test, volume_reservation_id)
         VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8, 'captured', $9, NOW(), $10, $11, TRUE, $12)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          messageId,
          campaign.id,
          targetEmail,
          subject,
          fromEmail,
          replyTo ?? null,
          htmlBody,
          textBody,
          unsubscribeToken,
          idempotencyKey,
          JSON.stringify({
            intent: "test-send",
            ...(unsubscribeUrl ? { opt_out_url: unsubscribeUrl } : {}),
          }),
          reserved.reservationId,
        ],
      );

      const accepted: { current: { id: string; raw?: string } | null } = { current: null };
      let providerAttempted = false;
      try {
        if (isLive) {
          let gate: Response | null = null;
          await withSubmitBarrier(async () => {
            if (["1", "true", "yes", "on"].includes((process.env.SENDSTACK_EMERGENCY_STOP ?? "").trim().toLowerCase())) {
              await releaseDailyReservation(reserved.reservationId, true);
              gate = json(403, { error: "SENDSTACK_EMERGENCY_STOP is enabled." });
              return;
            }
            if (!liveSendAllowed()) {
              await releaseDailyReservation(reserved.reservationId, true);
              gate = json(403, { error: "Live sending is disabled." });
              return;
            }
            if (!identityConfigured(identity) || !isTestRecipientAllowed(targetEmail, identity)) {
              await releaseDailyReservation(reserved.reservationId, true);
              gate = json(403, { error: "Identity/allowlist gate failed immediately before send." });
              return;
            }
            if (await isEmailSuppressed(targetEmail)) {
              await releaseDailyReservation(reserved.reservationId, true);
              await query(`UPDATE messages SET status = 'suppressed', error = $1 WHERE id = $2`, [
                "Late suppression before provider submit",
                messageId,
              ]);
              gate = json(403, { error: "That address is suppressed and cannot receive test email." });
              return;
            }
            providerAttempted = true;
            accepted.current = await sendSmtpEmail({
              to: targetEmail,
              subject,
              html: htmlBody || undefined,
              text: textBody || undefined,
              fromName: campaign.from_name,
              fromEmail,
              replyTo: replyTo || undefined,
            });
            if (accepted.current) {
              const raw =
                accepted.current.raw ||
                buildSentAppendSource({
                  from: `${campaign.from_name} <${fromEmail}>`,
                  to: targetEmail,
                  subject,
                  text: textBody || undefined,
                  html: htmlBody || undefined,
                  replyTo: replyTo || undefined,
                });
              const sentAppend = await appendToSentFolder(raw);
              if (!sentAppend.ok) {
                await query(
                  `UPDATE messages
                      SET diagnostic_json = COALESCE(diagnostic_json, '{}'::jsonb) || $1::jsonb
                    WHERE id = $2`,
                  [JSON.stringify({ sent_append_error: sentAppend.error }), messageId],
                ).catch(() => undefined);
              }
            }
          });
          if (gate) return gate;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Delivery failed.";
        // Stored diagnostics stay detailed for operators but must not retain tokens.
        const storedMessage = redactForLog(errorMessage).slice(0, 500);
        // Returned text must never expose driver or provider internals.
        const clientMessage = safeClientMessage(error, "Delivery failed.");
        if (providerAttempted) {
          await query(
            `UPDATE messages
                SET status = 'submission_unknown',
                    error = $1,
                    diagnostic_json = $2
              WHERE id = $3`,
            [storedMessage, JSON.stringify({ error: storedMessage, attempt_id: attemptId }), messageId],
          );
          return json(202, {
            queued: 1,
            sent: 0,
            failed: 0,
            status: "submission_unknown",
            attempt_id: attemptId,
            error: clientMessage,
          });
        }
        await query(
          `UPDATE messages SET status = 'failed', error = $1, diagnostic_json = $2 WHERE id = $3`,
          [storedMessage, JSON.stringify({ error: storedMessage }), messageId],
        );
        // Release only when no provider submission could have occurred.
        if (!providerAttempted) {
          await releaseDailyReservation(reserved.reservationId, true);
        }
        return json(500, { error: clientMessage });
      }

      if (accepted.current) {
        try {
          await query(
            `UPDATE messages SET status = 'submitted', provider_id = $1, diagnostic_json = $2 WHERE id = $3`,
            [
              accepted.current.id,
              JSON.stringify({
                provider_id: accepted.current.id,
                attempt_id: attemptId,
                ...(unsubscribeUrl ? { opt_out_url: unsubscribeUrl } : {}),
              }),
              messageId,
            ],
          );
        } catch {
          await query(
            `UPDATE messages SET status = 'submission_unknown', error = $1, diagnostic_json = $2 WHERE id = $3`,
            ["Local write failed after the provider accepted the email.", JSON.stringify({ attempt_id: attemptId }), messageId],
          ).catch(() => undefined);
          return json(202, {
            queued: 1,
            sent: 0,
            failed: 0,
            status: "submission_unknown",
            attempt_id: attemptId,
          });
        }
      }
      await consumeDailyReservation(reserved.reservationId);
      await recordRequestAudit(request, auth.session.user_id, "campaign_test_sent", "campaign", campaign.id, {
        recipients: 1,
        delivery_mode: config.deliveryMode,
        is_test: true,
        attempt_id: attemptId,
      });
      return json(200, { queued: 1, sent: 1, failed: 0, attempt_id: attemptId });
    }

    // --- Launch path ---
    if (campaign.status !== "draft" && campaign.status !== "paused") {
      return json(400, { error: "Only draft or paused campaigns can be launched." });
    }

    // Audience select/validate/persist happens inside claimAndPrepareCampaignLaunch (same TX).
    // Do not query live contacts here — that TOCTOU gap is closed by transactional freeze.

    let fromEmail = campaign.from_email;
    // Reply-To only when the campaign sets one — not from SENDSTACK_REPLY_TO_EMAIL.
    let replyTo: string | null = campaign.reply_to_email || null;
    if (isLive || isSmtpLaunch) {
      try {
        fromEmail = enforcedFromEmail(campaign.from_email, identity);
      } catch (error) {
        return json(403, { error: error instanceof Error ? error.message : "Sender identity is not configured." });
      }
    }

    const authoredHtml = campaign.html_body ?? "";
    const authoredText = campaign.text_body ?? "";
    const usesOptOut = templateUsesOptOut(campaign.subject, authoredHtml, authoredText);

    const preflight = runCampaignPreflight({
      subject: campaign.subject,
      htmlBody: authoredHtml,
      textBody: authoredText,
      fromEmail: campaign.from_email,
      fromName: campaign.from_name,
      identity,
      requirePublicHttps: isLive && usesOptOut,
    });
    if (!preflight.ok) {
      return json(400, { error: preflight.errors[0], errors: preflight.errors });
    }

    if (isSmtpLaunch && isLive) {
      if (!identityConfigured(identity)) {
          return json(403, { error: "Sender identity settings are incomplete. Live launch is blocked." });
      }
    }

    // Atomic CAS prepare: freeze snapshot, one active job, set-based recipients/messages/volume.
    // HTTP path never opens SMTP and never loops per recipient.
    try {
      const prepared = await claimAndPrepareCampaignLaunch({
        campaignId: campaign.id,
        liveMode: Boolean(isSmtpLaunch && isLive),
        fromEmail,
        replyToEmail: replyTo,
        htmlBody: authoredHtml,
        textBody: authoredText,
        validateLiveRecipients: Boolean(isSmtpLaunch && isLive),
      });
      if (prepared.totalRecipients === 0) {
        return json(400, { error: "No active, non-suppressed contacts are available to launch." });
      }
      await recordRequestAudit(request, auth.session.user_id, "campaign_launched", "campaign", campaign.id, {
        recipients: prepared.totalRecipients,
        delivery_mode: config.deliveryMode,
        launch_job_id: prepared.job.id,
        queued: true,
        idempotent: prepared.idempotent,
        live_mode: prepared.job.live_mode,
      });
      return json(200, {
        queued: prepared.totalRecipients,
        launch_job_id: prepared.job.id,
        status: "sending",
        sent: 0,
        idempotent: prepared.idempotent,
      });
    } catch (error) {
      const message = safeClientMessage(error, "Launch prepare failed.");
      if (/Daily delivery limit/i.test(message)) {
        return json(429, { error: message });
      }
      return json(400, { error: message });
    }
  }

  if (request.method === "POST" && route === "/launch-jobs/tick") {
    const auth = await requirePermission(request, "campaigns.send");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const workerId = `tick_${auth.session.user_id.slice(0, 12)}_${randomBytes(4).toString("hex")}`;
    const result = await runLaunchWorkerTick({
      workerId,
      timeBudgetMs: 15_000,
      live: liveSendAllowed(),
    });
    await recordRequestAudit(request, auth.session.user_id, "launch_job_ticked", "launch_jobs", result.launch_job_id, {
      worker_id: workerId,
      ...result,
    });
    return json(200, result);
  }
  if (request.method === "GET" && route === "/mailbox") {
    const auth = await requirePermission(request, "deliveries.view");
    if (auth.response) return auth.response;
    if (!mailboxReadAllowed()) {
      return json(503, {
        error: mailboxConfigured()
          ? "Mailbox reading is unavailable on preview deployments."
          : "Configure Spacemail mailbox credentials to read Inbox and Sent.",
      });
    }
    const folderParam = (new URL(request.url).searchParams.get("folder") || "inbox").trim().toLowerCase();
    if (folderParam !== "inbox" && folderParam !== "sent") {
      return json(400, { error: "folder must be inbox or sent." });
    }
    try {
      const messages = await listMailboxMessages(folderParam as MailboxFolder);
      return json(200, { folder: folderParam, messages });
    } catch (error) {
      return json(502, {
        error: error instanceof Error ? error.message : "Could not read the mailbox.",
      });
    }
  }
  if (request.method === "GET" && route === "/mailbox/message") {
    const auth = await requirePermission(request, "deliveries.view");
    if (auth.response) return auth.response;
    if (!mailboxReadAllowed()) {
      return json(503, {
        error: mailboxConfigured()
          ? "Mailbox reading is unavailable on preview deployments."
          : "Configure Spacemail mailbox credentials to read Inbox and Sent.",
      });
    }
    const params = new URL(request.url).searchParams;
    const folderParam = (params.get("folder") || "inbox").trim().toLowerCase();
    const uid = Number(params.get("uid") || "");
    if (folderParam !== "inbox" && folderParam !== "sent") {
      return json(400, { error: "folder must be inbox or sent." });
    }
    if (!Number.isFinite(uid) || uid < 1) {
      return json(400, { error: "uid must be a positive number." });
    }
    try {
      const message = await getMailboxMessage(folderParam as MailboxFolder, uid);
      if (!message) return json(404, { error: "Message not found." });
      return json(200, { folder: folderParam, message });
    } catch (error) {
      return json(502, {
        error: error instanceof Error ? error.message : "Could not open the mailbox message.",
      });
    }
  }
  if (request.method === "GET" && route === "/messages") {
    const auth = await requirePermission(request, "deliveries.view");
    if (auth.response) return auth.response;
    const params = new URL(request.url).searchParams;
    const campaignId = params.get("campaign_id")?.trim() || "";
    const q = params.get("q")?.trim() || "";
    const status = params.get("status")?.trim().toLowerCase() || "";
    const from = params.get("from")?.trim() || "";
    const to = params.get("to")?.trim() || "";
    const allowedStatuses = new Set([
      "captured",
      "submitted",
      "delivered",
      "failed",
      "bounced",
      "complained",
      "unsubscribed",
      "suppressed",
    ]);
    if (status && !allowedStatuses.has(status)) {
      return json(400, { error: "Invalid status filter." });
    }
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !datePattern.test(from)) || (to && !datePattern.test(to))) {
      return json(400, { error: "Dates must be YYYY-MM-DD." });
    }
    if (from && to && from > to) {
      return json(400, { error: "Start date must be on or before end date." });
    }

    const values: unknown[] = [];
    const where: string[] = [];
    if (campaignId) {
      values.push(campaignId);
      where.push(`m.campaign_id = $${values.length}`);
    }
    if (q) {
      values.push(q);
      const idx = values.length;
      where.push(
        `(m.to_email ILIKE '%' || $${idx} || '%' OR m.subject ILIKE '%' || $${idx} || '%' OR m.from_email ILIKE '%' || $${idx} || '%' OR COALESCE(c.name, '') ILIKE '%' || $${idx} || '%')`,
      );
    }
    if (status === "captured") {
      where.push(`m.status IN ('captured', 'sandboxed')`);
    } else if (status) {
      values.push(status);
      where.push(`m.status = $${values.length}`);
    }
    if (from) {
      values.push(from);
      where.push(`m.created_at >= $${values.length}::date`);
    }
    if (to) {
      values.push(to);
      where.push(`m.created_at < ($${values.length}::date + interval '1 day')`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const messages = await query(
      `SELECT m.id, m.to_email, m.subject, m.from_email, m.status, m.created_at, m.unsubscribe_token, c.name AS campaign_name
         FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id
         ${whereSql}
        ORDER BY m.created_at DESC LIMIT 500`,
      values,
    );
    return json(200, {
      messages: messages.rows,
      filters: {
        campaign_id: campaignId || null,
        q: q || null,
        status: status || null,
        from: from || null,
        to: to || null,
      },
    });
  }
  const messageMatch = route.match(/^\/messages\/([^/]+)$/);
  if (request.method === "GET" && messageMatch) {
    const auth = await requirePermission(request, "deliveries.view");
    if (auth.response) return auth.response;
    const message = await query(`SELECT m.*, c.name AS campaign_name FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id WHERE m.id = $1`, [messageMatch[1]]);
    if (!message.rows[0]) return json(404, { error: "Message not found." });
    return json(200, { message: message.rows[0] });
  }
  if (request.method === "DELETE" && messageMatch) {
    const auth = await requireAdmin(request);
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const deleted = await query(`DELETE FROM messages WHERE id = $1 RETURNING id`, [messageMatch[1]]);
    if (!deleted.rows[0]) return json(404, { error: "Message not found." });
    await recordRequestAudit(request, auth.session.user_id, "message_deleted", "message", messageMatch[1]);
    return json(200, { ok: true });
  }
  const messageEventMatch = route.match(/^\/messages\/([^/]+)\/event$/);
  if (request.method === "POST" && messageEventMatch) {
    const auth = await requirePermission(request, "deliveries.feedback");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }
    const messageId = messageEventMatch[1];
    const body = await request.json().catch(() => ({})) as { event?: string };
    const event = (body.event ?? "").trim().toLowerCase();
    const allowed: Record<string, { messageStatus: string; recipientStatus: string; reason: "hard_bounce" | "complaint" }> = {
      hard_bounce: { messageStatus: "bounced", recipientStatus: "bounced", reason: "hard_bounce" },
      bounce: { messageStatus: "bounced", recipientStatus: "bounced", reason: "hard_bounce" },
      complaint: { messageStatus: "complained", recipientStatus: "complained", reason: "complaint" },
    };
    const mapped = allowed[event];
    if (!mapped) {
      return json(400, { error: "Supported events: hard_bounce, complaint." });
    }

    const message = await query<{
      id: string;
      to_email: string;
      status: string;
      campaign_id: string | null;
      provider_id: string | null;
    }>(`SELECT id, to_email, status, campaign_id, provider_id FROM messages WHERE id = $1`, [messageId]);
    const row = message.rows[0];
    if (!row) return json(404, { error: "Message not found." });
    if (!canTransitionMessageStatus(row.status, mapped.messageStatus)) {
      return json(409, {
        error: `Cannot transition message from ${row.status} to ${mapped.messageStatus}.`,
        status: row.status,
      });
    }

    await applySuppression(row.to_email, mapped.reason, "admin_simulate");
    const nextRank = messageStatusRank(mapped.messageStatus);
    await query(
      `UPDATE messages
          SET status = $1,
              status_rank = $2,
              diagnostic_json = $3
        WHERE id = $4
          AND $2 >= status_rank`,
      [
        mapped.messageStatus,
        nextRank,
        JSON.stringify({ source: "admin_simulate", event, actor: auth.session.user_id }),
        messageId,
      ],
    );
    if (row.campaign_id) {
      await query(
        `UPDATE campaign_recipients
            SET status = $1
          WHERE campaign_id = $2
            AND (
              message_id = $3
              OR (lower(email) = lower($4) AND ($5::text IS NULL OR provider_email_id = $5 OR provider_email_id IS NULL))
            )
            AND status <> ALL(ARRAY['complained','cancelled']::text[])`,
        [mapped.recipientStatus, row.campaign_id, messageId, row.to_email, row.provider_id],
      );
    }
    await recordRequestAudit(request, auth.session.user_id, "message_feedback_simulated", "message", messageId, {
      event,
      status: mapped.messageStatus,
      email: row.to_email,
      campaign_id: row.campaign_id,
    });
    return json(200, { ok: true, status: mapped.messageStatus });
  }
  if (request.method === "POST" && route === "/contacts") {
    const auth = await requirePermission(request, "contacts.manage");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }

    const body = await request.json().catch(() => ({})) as {
      email?: string;
      list_id?: string;
    };
    const email = normalizeEmail(body.email ?? "");
    if (!validEmail(email)) return json(400, { error: "Enter a valid email address." });
    if (!body.list_id) return json(400, { error: "Select a destination list." });

    const list = await query(`SELECT id FROM lists WHERE id = $1`, [body.list_id]);
    if (!list.rows[0]) return json(400, { error: "The selected list does not exist." });
    const existing = await query(`SELECT id FROM contacts WHERE email = $1`, [email]);
    if (existing.rows[0]) return json(409, { error: "That email address already exists." });

    let created: { id: string; status: string };
    try {
      created = await createContact({
        email,
        listId: body.list_id,
      });
    } catch (error) {
      return json(400, { error: safeClientMessage(error, "Could not create contact.") });
    }
    await recordRequestAudit(request, auth.session.user_id, "contact_created", "contact", created.id, {
      email,
      list_id: body.list_id,
      status: created.status,
    });
    return json(201, {
      contact: {
        id: created.id,
        email,
        first_name: "",
        last_name: "",
        status: created.status,
      },
    });
  }
  if (request.method === "POST" && route === "/auth/change-password") {
    const session = await currentSession(request);
    if (!session) return json(401, { error: "Not signed in." });
    if (!hasValidCsrf(request, session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }

    const body = await request.json().catch(() => ({})) as {
      current_password?: string;
      new_password?: string;
    };
    if (!body.current_password || !verifyPassword(body.current_password, (await query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [session.user_id],
    )).rows[0]?.password_hash ?? "")) {
      return json(400, { error: "Current password is incorrect." });
    }
    if (!body.new_password || body.new_password.length < 12) {
      return json(400, { error: "New password must be at least 12 characters." });
    }
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const hours = Number(process.env.SENDSTACK_SESSION_HOURS ?? 12);
    const passwordClient = await getPool().connect();
    try {
      await passwordClient.query("BEGIN");
      await passwordClient.query(
        `UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
        [hashPassword(body.new_password), session.user_id],
      );
      await passwordClient.query(`DELETE FROM sessions WHERE user_id = $1`, [session.user_id]);
      await passwordClient.query(
        `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
         VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 hour'), NOW())`,
        [tokenHash(token), session.user_id, csrfToken, hours],
      );
      await passwordClient.query("COMMIT");
    } catch (error) {
      await passwordClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      passwordClient.release();
    }
    await recordRequestAudit(request, session.user_id, "password_changed", "user", session.user_id);
    const response = json(200, await sessionPayload({
      ...session,
      must_change_password: false,
      csrf_token: csrfToken,
      token,
    }));
    response.headers.set("Set-Cookie", cookieHeader(token, hours * 3600));
    return response;
  }
  if (request.method === "POST" && route === "/auth/logout") {
    const token = cookieValue(request, "sendstack_session");
    const session = await currentSession(request);
    if (token) await query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash(token)]);
    if (session) await recordRequestAudit(request, session.user_id, "logout", "session", token ? tokenHash(token) : null);
    const response = json(200, { ok: true });
    response.headers.set("Set-Cookie", cookieHeader("", 0));
    return response;
  }
  return json(404, { error: "API route not implemented." });
}
