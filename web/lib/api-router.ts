import { createHash, randomBytes } from "crypto";
import { json } from "./http";
import { config } from "./config";
import { query } from "./db";
import { getDeliveryHealthSnapshot } from "./delivery-health";
import { DAILY_LIMIT_MESSAGE_STATUSES } from "./delivery-status";
import { hashPassword, makeId, normalizeEmail, validEmail, verifyPassword } from "./ids";
import { runCampaignPreflight } from "./preflight";
import {
  addContactToSegment,
  buildIdempotencyKey,
  cancelResendBroadcast,
  createResendBroadcastDraft,
  createResendSegment,
  liveSendAllowed,
  sendResendBroadcast,
  sendResendEmail,
  toResendBroadcastHtml,
  toResendBroadcastText,
  upsertResendContact,
} from "./providers/resend";
import { shouldReuseExistingBroadcast } from "./providers/webhook";
import { isSpecialUseRecipientDomain, validateLiveRecipient } from "./recipients";
import {
  enforcedFromEmail,
  enforcedReplyTo,
  identityComplianceGaps,
  identityConfigured,
  isTestRecipientAllowed,
  loadSendingIdentity,
} from "./sending-identity";
import { applySuppression, isEmailSuppressed, removeSuppressionWithReconsent } from "./suppressions";
import {
  ATTACHMENT_MAX_COUNT,
  attachmentMeta,
  isArchiveAttachmentFilename,
  validateCampaignAttachment,
} from "./attachments";
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
  const secure = config.cookieSecure ? "; Secure" : "";
  return `sendstack_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function hasValidCsrf(request: Request, csrfToken: string): boolean {
  return requireCsrf(request, { csrfToken }) === null;
}

function renderContactTemplate(
  value: string,
  contact: { email: string; first_name?: string; last_name?: string },
  unsubscribeUrl: string,
): string {
  return renderTemplate(value, {
    first_name: contact.first_name ?? "",
    last_name: contact.last_name ?? "",
    email: contact.email,
    unsubscribe_url: unsubscribeUrl,
  });
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

function sessionPayload(session: NonNullable<Awaited<ReturnType<typeof currentSession>>>) {
  const identity = loadSendingIdentity();
  return {
    csrf_token: session.csrf_token,
    permissions: [...permissionsForRole(session.role)],
    delivery_mode: config.deliveryMode,
    daily_limit: config.dailyLimit,
    must_change_password: session.must_change_password,
    enforced_from_email: identity.fromEmail || null,
    reply_to_email: identity.replyToEmail || null,
    company_name: identity.companyName || null,
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

async function countTowardDailyLimit(): Promise<number> {
  const statusList = DAILY_LIMIT_MESSAGE_STATUSES.map((status) => `'${status}'`).join(", ");
  const messages = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM messages
      WHERE created_at >= CURRENT_DATE
        AND status IN (${statusList})`,
  );
  // Broadcast recipients that were snapshotted today but may not yet have message rows.
  const broadcastRecipients = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
       FROM campaign_recipients cr
       JOIN campaigns c ON c.id = cr.campaign_id
      WHERE cr.queued_at >= CURRENT_DATE
        AND c.provider_broadcast_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.recipient_id = cr.id)`,
  );
  return Number(messages.rows[0]?.count ?? 0) + Number(broadcastRecipients.rows[0]?.count ?? 0);
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
  const sentToday = await countTowardDailyLimit();
  const recentCampaigns = await query(
    `SELECT c.id, c.name, c.subject, c.status,
            COUNT(cr.id)::int AS recipients,
            COUNT(cr.id) FILTER (WHERE cr.status IN ('sent', 'delayed'))::int AS sent,
            COUNT(cr.id) FILTER (WHERE cr.status IN ('failed', 'bounced', 'complained', 'suppressed'))::int AS issues
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
    provider_broadcast_id: string | null; provider_segment_id: string | null;
    launch_lock_token: string | null;
  }>(
    `SELECT c.*, l.name AS list_name FROM campaigns c JOIN lists l ON l.id = c.list_id WHERE c.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function withinDailyLimit(additional = 0): Promise<boolean> {
  const used = await countTowardDailyLimit();
  return used + additional <= config.dailyLimit;
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

async function launchResendBroadcast(
  campaign: NonNullable<Awaited<ReturnType<typeof campaignById>>>,
  contacts: Array<{ id: string; email: string; first_name: string; last_name: string }>,
) {
  if (!liveSendAllowed()) {
    throw new Error("Live Resend sending is not enabled.");
  }
  if (!identityConfigured()) {
    throw new Error("Identity and compliance settings are incomplete. Live launch is blocked.");
  }
  const fromEmail = enforcedFromEmail(campaign.from_email);
  const replyTo = enforcedReplyTo();

  for (const contact of contacts) {
    const live = validateLiveRecipient(contact.email);
    if (!live.ok) {
      throw new Error(`Recipient ${contact.email}: ${live.error}`);
    }
  }

  const lockToken = `lock_${randomBytes(16).toString("hex")}`;
  const locked = await query<{ id: string; provider_broadcast_id: string | null; provider_segment_id: string | null }>(
    `UPDATE campaigns
        SET launch_lock_token = $1,
            status = 'sending',
            from_email = $3,
            reply_to_email = $4,
            launched_at = COALESCE(launched_at, NOW()),
            updated_at = NOW(),
            cancellable = TRUE,
            provider_status = 'launching'
      WHERE id = $2
        AND status IN ('draft', 'paused')
        AND (launch_lock_token IS NULL OR launch_lock_token = $1)
      RETURNING id, provider_broadcast_id, provider_segment_id`,
    [lockToken, campaign.id, fromEmail, replyTo],
  );
  if (!locked.rows[0]) {
    throw new Error("Could not acquire launch lock. Another launch may already be in progress.");
  }

  let segmentId = locked.rows[0].provider_segment_id;
  let broadcastId = locked.rows[0].provider_broadcast_id;

  // Persist recipient + message intent before any provider submission.
  for (const contact of contacts) {
    const recipientId = makeId("rec");
    const messageId = makeId("msg");
    const unsubscribeToken = randomBytes(24).toString("base64url");
    const idempotencyKey = buildIdempotencyKey(["broadcast", campaign.id, contact.id]);
    const inserted = await query<{ id: string; message_id: string }>(
      `INSERT INTO campaign_recipients
         (id, campaign_id, contact_id, email, status, message_id, provider_email_id, queued_at, sent_at)
       VALUES ($1, $2, $3, $4, 'queued', $5, NULL, NOW(), NULL)
       ON CONFLICT (campaign_id, contact_id) DO UPDATE
         SET email = EXCLUDED.email
       RETURNING id, message_id`,
      [recipientId, campaign.id, contact.id, contact.email, messageId],
    );
    const recipientRow = inserted.rows[0];
    const existingMessage = await query<{ id: string }>(
      `SELECT id FROM messages WHERE recipient_id = $1 LIMIT 1`,
      [recipientRow.id],
    );
    if (!existingMessage.rows[0]) {
      await query(
        `INSERT INTO messages
           (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email, reply_to_email,
            html_body, text_body, status, unsubscribe_token, created_at, idempotency_key, diagnostic_json, is_test)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', $11, NOW(), $12, $13, FALSE)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          recipientRow.message_id || messageId,
          campaign.id,
          recipientRow.id,
          contact.id,
          contact.email,
          campaign.subject,
          fromEmail,
          replyTo,
          campaign.html_body,
          campaign.text_body,
          unsubscribeToken,
          idempotencyKey,
          JSON.stringify({ intent: "broadcast", campaign_id: campaign.id }),
        ],
      );
    }
  }

  if (!segmentId) {
    const segment = await createResendSegment(`SendStack ${campaign.id}`);
    segmentId = segment.id;
    await query(`UPDATE campaigns SET provider_segment_id = $1, updated_at = NOW() WHERE id = $2`, [segmentId, campaign.id]);
  }

  for (const contact of contacts) {
    const providerContact = await upsertResendContact({
      email: contact.email,
      firstName: contact.first_name,
      lastName: contact.last_name,
    });
    await addContactToSegment(providerContact.id, segmentId);
    await query(`UPDATE contacts SET provider_contact_id = $1, updated_at = NOW() WHERE id = $2`, [providerContact.id, contact.id]);
  }

  if (!shouldReuseExistingBroadcast(broadcastId)) {
    const draft = await createResendBroadcastDraft({
      segmentId,
      fromName: campaign.from_name,
      fromEmail,
      replyTo,
      subject: campaign.subject,
      html: toResendBroadcastHtml(campaign.html_body),
      text: toResendBroadcastText(campaign.text_body),
      name: `campaign:${campaign.id}`,
    });
    broadcastId = draft.id;
    await query(
      `UPDATE campaigns
          SET provider_broadcast_id = $1, provider_status = 'draft', cancellable = TRUE, updated_at = NOW()
        WHERE id = $2`,
      [broadcastId, campaign.id],
    );
  }

  const sendKey = buildIdempotencyKey(["broadcast-send", campaign.id, broadcastId!]);
  await sendResendBroadcast(broadcastId!, sendKey);
  await query(
    `UPDATE campaign_recipients SET status = 'processing' WHERE campaign_id = $1 AND status = 'queued'`,
    [campaign.id],
  );
  await query(
    `UPDATE campaigns
        SET launch_lock_token = NULL,
            provider_status = 'queued',
            cancellable = TRUE,
            updated_at = NOW()
      WHERE id = $1`,
    [campaign.id],
  );
  return { queued: contacts.length, broadcastId, segmentId };
}

async function listCampaignAttachmentMeta(campaignId: string) {
  const result = await query<{
    id: string;
    filename: string;
    content_type: string;
    byte_size: number;
  }>(
    `SELECT id, filename, content_type, byte_size
       FROM campaign_attachments
      WHERE campaign_id = $1
      ORDER BY created_at ASC`,
    [campaignId],
  );
  return result.rows.map(attachmentMeta);
}

async function loadCampaignAttachmentsForSend(campaignId: string) {
  const result = await query<{
    filename: string;
    content_type: string;
    content: Buffer;
  }>(
    `SELECT filename, content_type, content
       FROM campaign_attachments
      WHERE campaign_id = $1
        AND COALESCE(blocked, FALSE) = FALSE
      ORDER BY created_at ASC`,
    [campaignId],
  );
  return result.rows
    .filter((row) => !isArchiveAttachmentFilename(row.filename))
    .map((row) => ({
      filename: row.filename,
      contentType: row.content_type,
      contentBase64: Buffer.from(row.content).toString("base64"),
    }));
}

async function readinessResponse() {
  const identity = loadSendingIdentity();
  const gaps = identityComplianceGaps(identity);
  const identityReady = gaps.length === 0;
  const resendKeys = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_WEBHOOK_SECRET);
  const resendConfigured = resendKeys && identityReady;
  const production = config.isVercelProduction || config.nodeEnv === "production";
  const health = await getDeliveryHealthSnapshot();
  const readyForLive =
    production &&
    config.deliveryMode === "resend" &&
    config.liveSendEnabled &&
    resendConfigured &&
    health.healthy;

  return json(200, {
    target: { platform: "Vercel", database: "Managed PostgreSQL", provider: "Resend Broadcasts" },
    current: {
      runtime: "Vercel",
      database: config.databaseUrl ? "PostgreSQL" : "Not configured",
      transport: config.deliveryMode,
      from_email: identity.fromEmail || null,
      reply_to_email: identity.replyToEmail || null,
      company_name: identity.companyName || null,
    },
    ready_for_live_sending: readyForLive,
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
        status: config.databaseUrl ? "ready" : "migration_required",
        detail: config.databaseUrl
          ? "The managed database is connected."
          : "Connect the managed database and apply migrations.",
      },
      {
        id: "sender_identity",
        label: "Sender identity & compliance",
        status: identityReady ? "ready" : "pending",
        detail: identityReady
          ? `From ${identity.fromEmail}, Reply-To ${identity.replyToEmail}, company and postal address configured.`
          : `Missing: ${gaps.map((gap) => gap.label).join(", ")}.`,
      },
      {
        id: "resend_broadcasts",
        label: "Resend delivery",
        status: resendConfigured && config.liveSendEnabled ? "ready" : resendConfigured ? "configured_locked" : "not_connected",
        detail: resendConfigured && config.liveSendEnabled
          ? "Live email through Resend is enabled."
          : resendConfigured
            ? "Resend is configured. Live email is turned off until an administrator enables it."
            : "Connect Resend and complete identity settings before live email can be enabled.",
      },
      {
        id: "delivery_health",
        label: "Webhook & suppression health",
        status: health.healthy ? "ready" : "pending",
        detail: health.healthy
          ? "Webhook correlation and suppression synchronization look complete."
          : health.issues.join(" ") || "Delivery health checks are incomplete.",
      },
    ],
    delivery_health: health,
    delivery_path: [
      "Create a campaign draft with monitored From/Reply-To identity",
      "Pass launch preflight (no placeholders, allowed links, no archives)",
      "Verify audience suppressions and daily volume headroom",
      "Submit through Resend with persisted recipient intent and idempotency keys",
    ],
    volume_plan: {
      goal: `${config.dailyLimit.toLocaleString()} emails/day`,
      launch_policy: "Increase volume only after delivery and complaint signals remain healthy and webhook correlation is complete.",
    },
    identity_gaps: gaps,
  });
}

export async function handleApi(request: Request, path: string[]) {
  const route = `/${path.join("/")}`;
  if (!(request.method === "POST" && route === "/auth/login")) {
    const session = await currentSession(request);
    if (session?.must_change_password && !passwordChangeAllowedPath(`/api${route}`, request.method)) {
      return json(403, { error: "You must change your password before continuing." });
    }
  }
  if (request.method === "POST" && route === "/auth/login") {
    const body = await request.json().catch(() => ({})) as { email?: string; password?: string };
    const result = await query<{ id: string; email: string; name: string; role: "admin" | "marketer" | "analyst"; password_hash: string; must_change_password: boolean }>(
      `SELECT id, email, name, role, password_hash, must_change_password FROM users WHERE email = $1 AND active = TRUE`,
      [normalizeEmail(body.email ?? "")],
    );
    const user = result.rows[0];
    if (!user || !body.password || !verifyPassword(body.password, user.password_hash)) {
      await recordRequestAudit(request, user?.id ?? null, "login_failed", "authentication", user?.id ?? null, { email: normalizeEmail(body.email ?? "") });
      return json(401, { error: "Invalid email or password." });
    }
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const hours = Number(process.env.SENDSTACK_SESSION_HOURS ?? 12);
    await query(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 hour'), NOW())`,
      [tokenHash(token), user.id, csrfToken, hours],
    );
    const response = json(200, sessionPayload({ ...user, user_id: user.id, token_hash: tokenHash(token), csrf_token: csrfToken, token } as never));
    response.headers.set("Set-Cookie", cookieHeader(token, hours * 3600));
    await recordRequestAudit(request, user.id, "login_succeeded", "session", tokenHash(token), { role: user.role });
    return response;
  }
  if (request.method === "GET" && route === "/session") {
    const session = await currentSession(request);
    return session ? json(200, sessionPayload(session)) : json(401, { error: "Not signed in." });
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
    return json(200, { delivery_health: health });
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
    const body = await request.json().catch(() => ({})) as { consent_note?: string };
    try {
      const result = await removeSuppressionWithReconsent({
        email,
        actorUserId: auth.session.user_id,
        consentNote: body.consent_note ?? "",
      });
      if (!result.removed) return json(404, { error: "Suppression not found." });
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : "Re-consent is required." });
    }
    await recordRequestAudit(request, auth.session.user_id, "suppression_reconsent_removed", "suppression", email, {
      consent_note: (body.consent_note ?? "").trim(),
      provider_reactivation: false,
    });
    return json(200, { ok: true, provider_reactivated: false });
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

    const body = await request.json().catch(() => ({})) as { csv_text?: string; list_id?: string };
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

    const headers = parseCsvLine(lines[0]).map((header) => header.trim().toLowerCase().replace(/\s+/g, "_"));
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

    for (let index = 1; index < lines.length; index += 1) {
      const row = index + 1;
      const cells = parseCsvLine(lines[index]);
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
      const existing = await query<{ id: string }>(`SELECT id FROM contacts WHERE email = $1`, [email]);
      if (existing.rows[0]) {
        const contactId = existing.rows[0].id;
        await query(
          `UPDATE contacts SET first_name = CASE WHEN $1 = '' THEN first_name ELSE $1 END,
             last_name = CASE WHEN $2 = '' THEN last_name ELSE $2 END, updated_at = NOW()
           WHERE id = $3`,
          [firstName, lastName, contactId],
        );
        await query(
          `INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())
           ON CONFLICT (list_id, contact_id) DO NOTHING`,
          [listId, contactId],
        );
        updated += 1;
        continue;
      }

      const id = `con_${randomBytes(16).toString("hex")}`;
      const suppressed = await query(`SELECT 1 FROM suppressions WHERE email = $1`, [email]);
      await query(
        `INSERT INTO contacts
           (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'csv_import', NOW(), NOW(), NOW())`,
        [id, email, firstName, lastName, suppressed.rows[0] ? "suppressed" : "active"],
      );
      await query(
        `INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`,
        [listId, id],
      );
      imported += 1;
    }

    await recordRequestAudit(request, auth.session.user_id, "contacts_imported", "list", listId, {
      imported,
      updated,
      duplicates,
      invalid,
    });
    return json(200, { imported, updated, duplicates, invalid, issues, issues_truncated: issuesTruncated });
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
      first_name?: string;
      last_name?: string;
      status?: string;
      consent_source?: string;
      list_id?: string;
    };
    const email = normalizeEmail(body.email ?? "");
    if (!validEmail(email)) return json(400, { error: "Enter a valid email address." });
    if (!body.status || !["active", "suppressed"].includes(body.status)) return json(400, { error: "Select a valid contact status." });
    const consentSource = (body.consent_source ?? "").trim();
    if (!consentSource) return json(400, { error: "Consent source is required." });

    const conflict = await query(
      `SELECT id FROM contacts WHERE email = $1 AND id <> $2`,
      [email, contactMatch[1]],
    );
    if (conflict.rows[0]) return json(409, { error: "That email address already exists." });

    if (body.list_id) {
      const list = await query(`SELECT id FROM lists WHERE id = $1`, [body.list_id]);
      if (!list.rows[0]) return json(400, { error: "The selected list does not exist." });
    }

    const updated = await query(
      `UPDATE contacts SET email = $1, first_name = $2, last_name = $3, status = $4, consent_source = $5, updated_at = NOW()
       WHERE id = $6 RETURNING id, email, first_name, last_name, status, consent_source, created_at`,
      [email, (body.first_name ?? "").trim(), (body.last_name ?? "").trim(), body.status, consentSource, contactMatch[1]],
    );
    if (!updated.rows[0]) return json(404, { error: "Contact not found." });

    if (body.list_id) {
      await query(`DELETE FROM list_contacts WHERE contact_id = $1`, [contactMatch[1]]);
      await query(
        `INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`,
        [body.list_id, contactMatch[1]],
      );
    }

    await recordRequestAudit(request, auth.session.user_id, "contact_updated", "contact", contactMatch[1], {
      email,
      status: body.status,
      list_id: body.list_id ?? null,
    });
    return json(200, { contact: updated.rows[0] });
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
              COUNT(cr.id) FILTER (WHERE cr.status = 'sent')::int AS sent,
              COUNT(cr.id) FILTER (WHERE cr.status = 'queued')::int AS queued,
              COUNT(cr.id) FILTER (WHERE cr.status = 'failed')::int AS failed,
              COUNT(cr.id) FILTER (WHERE cr.status = 'bounced')::int AS bounced,
              COUNT(cr.id) FILTER (WHERE cr.status = 'complained')::int AS complained
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
    return json(201, { campaign: { id, name, subject, status: "draft", list_id: listId, attachments: [] } });
  }
  const attachmentDeleteMatch = route.match(/^\/campaigns\/([^/]+)\/attachments\/([^/]+)$/);
  if (request.method === "DELETE" && attachmentDeleteMatch) {
    const auth = await requirePermission(request, "campaigns.manage");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const campaign = await campaignById(attachmentDeleteMatch[1]);
    if (!campaign) return json(404, { error: "Campaign not found." });
    if (campaign.status !== "draft") return json(409, { error: "Attachments can only be changed on draft campaigns." });
    const deleted = await query(
      `DELETE FROM campaign_attachments WHERE id = $1 AND campaign_id = $2 RETURNING id, filename`,
      [attachmentDeleteMatch[2], campaign.id],
    );
    if (!deleted.rows[0]) return json(404, { error: "Attachment not found." });
    await recordRequestAudit(request, auth.session.user_id, "campaign_attachment_deleted", "campaign", campaign.id, {
      attachment_id: deleted.rows[0].id,
      filename: deleted.rows[0].filename,
    });
    return json(200, { ok: true, attachments: await listCampaignAttachmentMeta(campaign.id) });
  }
  const attachmentCollectionMatch = route.match(/^\/campaigns\/([^/]+)\/attachments$/);
  if (request.method === "GET" && attachmentCollectionMatch) {
    const auth = await requirePermission(request, "campaigns.view");
    if (auth.response) return auth.response;
    const campaign = await campaignById(attachmentCollectionMatch[1]);
    if (!campaign) return json(404, { error: "Campaign not found." });
    return json(200, { attachments: await listCampaignAttachmentMeta(campaign.id) });
  }
  if (request.method === "POST" && attachmentCollectionMatch) {
    const auth = await requirePermission(request, "campaigns.manage");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) return json(403, { error: "CSRF validation failed." });
    const campaign = await campaignById(attachmentCollectionMatch[1]);
    if (!campaign) return json(404, { error: "Campaign not found." });
    if (campaign.status !== "draft") return json(409, { error: "Attachments can only be added to draft campaigns." });

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return json(400, { error: "Choose a file to attach." });
    const bytes = Buffer.from(await file.arrayBuffer());
    const existing = await query<{ count: string; total_bytes: string }>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(byte_size), 0)::int AS total_bytes
         FROM campaign_attachments WHERE campaign_id = $1`,
      [campaign.id],
    );
    const existingCount = Number(existing.rows[0]?.count ?? 0);
    const existingTotalBytes = Number(existing.rows[0]?.total_bytes ?? 0);
    const validated = validateCampaignAttachment({
      filename: file.name || "attachment",
      contentType: file.type || "",
      byteSize: bytes.length,
      existingCount,
      existingTotalBytes,
      bytes,
    });
    if (!validated.ok) return json(400, { error: validated.error });

    const attachmentId = makeId("att");
    await query(
      `INSERT INTO campaign_attachments (id, campaign_id, filename, content_type, byte_size, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [attachmentId, campaign.id, validated.filename, validated.contentType, bytes.length, bytes],
    );
    await recordRequestAudit(request, auth.session.user_id, "campaign_attachment_added", "campaign", campaign.id, {
      attachment_id: attachmentId,
      filename: validated.filename,
      byte_size: bytes.length,
    });
    return json(201, {
      attachment: {
        id: attachmentId,
        filename: validated.filename,
        content_type: validated.contentType,
        byte_size: bytes.length,
      },
      attachments: await listCampaignAttachmentMeta(campaign.id),
      limits: { max_count: ATTACHMENT_MAX_COUNT },
    });
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
    const attachments = await listCampaignAttachmentMeta(campaign.id);
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
        attachments,
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
    const body = await request.json().catch(() => ({})) as { email?: string };
    const targetEmail = normalizeEmail(body.email ?? "");
    const identity = loadSendingIdentity();
    const isTestSend = campaignAction[2] === "test-send";
    const isLive = config.deliveryMode === "resend" && liveSendAllowed();

    if (campaignAction[2] === "pause") {
      if (campaign.status !== "sending") {
        return json(409, { error: "Only sending campaigns can be paused or cancelled." });
      }
      if (campaign.provider_broadcast_id && isLive) {
        try {
          await cancelResendBroadcast(campaign.provider_broadcast_id);
          await query(
            `UPDATE campaigns
                SET status = 'cancelled',
                    provider_status = 'cancelled',
                    cancellable = FALSE,
                    updated_at = NOW()
              WHERE id = $1`,
            [campaign.id],
          );
          await query(
            `UPDATE campaign_recipients
                SET status = 'cancelled'
              WHERE campaign_id = $1 AND status IN ('queued', 'processing')`,
            [campaign.id],
          );
          await recordRequestAudit(request, auth.session.user_id, "campaign_cancelled", "campaign", campaign.id, {
            provider_broadcast_id: campaign.provider_broadcast_id,
            provider_cancelled: true,
          });
          return json(200, { ok: true, status: "cancelled", provider_cancelled: true });
        } catch (error) {
          await query(
            `UPDATE campaigns
                SET provider_status = 'cancel_failed',
                    cancellable = FALSE,
                    updated_at = NOW()
              WHERE id = $1`,
            [campaign.id],
          );
          return json(409, {
            error:
              error instanceof Error
                ? `Provider can no longer stop this broadcast: ${error.message}`
                : "Provider can no longer stop this broadcast.",
            status: campaign.status,
            cancellable: false,
          });
        }
      }
      await query(`UPDATE campaigns SET status = 'paused', cancellable = FALSE, updated_at = NOW() WHERE id = $1`, [campaign.id]);
      await recordRequestAudit(request, auth.session.user_id, "campaign_paused", "campaign", campaign.id, {
        status: "paused",
        local_only: true,
      });
      return json(200, { ok: true, status: "paused", provider_cancelled: false });
    }

    if (campaignAction[2] === "resume") {
      if (campaign.status !== "paused") {
        return json(409, { error: "Only paused campaigns can be resumed." });
      }
      if (campaign.provider_broadcast_id) {
        return json(409, {
          error: "A provider broadcast already exists. Create a new campaign draft instead of resuming a cancelled or partially sent broadcast.",
        });
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
      if (isLive) {
        if (!identityConfigured(identity)) {
          return json(403, { error: "Identity and compliance settings are required before live test sends." });
        }
        if (!isTestRecipientAllowed(targetEmail, identity)) {
          return json(403, { error: "Test recipient is not on SENDSTACK_TEST_RECIPIENT_ALLOWLIST." });
        }
      }
      if (await isEmailSuppressed(targetEmail)) {
        return json(403, { error: "That address is suppressed and cannot receive test email." });
      }
      if (!await withinDailyLimit(1)) {
        return json(429, { error: "Daily delivery limit reached." });
      }
    }

    const contacts = isTestSend
      ? [{ id: null as string | null, email: targetEmail, first_name: "Test", last_name: "Recipient" }]
      : (await query<{ id: string; email: string; first_name: string; last_name: string }>(
          `SELECT c.id, c.email, c.first_name, c.last_name
             FROM contacts c JOIN list_contacts lc ON lc.contact_id = c.id
            WHERE lc.list_id = $1 AND c.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`,
          [campaign.list_id],
        )).rows;

    if (campaignAction[2] === "launch") {
      if (campaign.status !== "draft" && campaign.status !== "paused") {
        return json(400, { error: "Only draft or paused campaigns can be launched." });
      }
      const attachmentRows = await query<{ filename: string }>(
        `SELECT filename FROM campaign_attachments WHERE campaign_id = $1 AND blocked = FALSE`,
        [campaign.id],
      );
      const blockedArchives = await query<{ filename: string }>(
        `SELECT filename FROM campaign_attachments WHERE campaign_id = $1 AND (blocked = TRUE OR lower(filename) LIKE '%.zip')`,
        [campaign.id],
      );
      if (blockedArchives.rows.length) {
        return json(400, {
          error: "This campaign has archive attachments that cannot be sent. Remove or leave them blocked before launch.",
        });
      }
      const preflight = runCampaignPreflight({
        subject: campaign.subject,
        htmlBody: campaign.html_body,
        textBody: campaign.text_body,
        fromEmail: campaign.from_email,
        fromName: campaign.from_name,
        attachmentExtensions: attachmentRows.rows.map((row) => row.filename.split(".").pop()?.toLowerCase() || ""),
        identity,
      });
      if (!preflight.ok) {
        return json(400, { error: preflight.errors[0], errors: preflight.errors });
      }
      if (isLive && contacts.some((contact) => isSpecialUseRecipientDomain(contact.email))) {
        return json(400, { error: "Audience contains special-use domains that cannot receive live email." });
      }
      if (!await withinDailyLimit(contacts.length)) {
        return json(429, { error: "Daily delivery limit reached." });
      }
    }

    if (campaignAction[2] === "launch" && config.deliveryMode === "resend") {
      try {
        const result = await launchResendBroadcast(
          campaign,
          contacts.filter((contact): contact is { id: string; email: string; first_name: string; last_name: string } => Boolean(contact.id)),
        );
        await recordRequestAudit(request, auth.session.user_id, "campaign_launched", "campaign", campaign.id, {
          recipients: result.queued,
          delivery_mode: "resend",
          provider_broadcast_id: result.broadcastId,
          provider_segment_id: result.segmentId,
        });
        return json(200, { queued: result.queued, sent: 0, provider_broadcast_id: result.broadcastId });
      } catch (error) {
        await query(
          `UPDATE campaigns
              SET launch_lock_token = NULL,
                  status = CASE WHEN status = 'sending' THEN 'failed' ELSE status END,
                  provider_status = 'launch_failed',
                  cancellable = FALSE,
                  updated_at = NOW()
            WHERE id = $1`,
          [campaign.id],
        );
        await query(
          `UPDATE campaign_recipients
              SET status = 'failed', error = $2
            WHERE campaign_id = $1 AND status IN ('queued', 'processing')`,
          [campaign.id, (error instanceof Error ? error.message : "Broadcast launch failed.").slice(0, 500)],
        );
        await query(
          `UPDATE messages
              SET status = 'failed', error = $2
            WHERE campaign_id = $1
              AND status = 'submitted'
              AND provider_id IS NULL`,
          [campaign.id, (error instanceof Error ? error.message : "Broadcast launch failed.").slice(0, 500)],
        );
        return json(500, { error: error instanceof Error ? error.message : "Broadcast launch failed." });
      }
    }

    if (campaignAction[2] === "launch") {
      await query(
        `UPDATE campaigns
            SET status = 'sending', launched_at = COALESCE(launched_at, NOW()), updated_at = NOW()
          WHERE id = $1`,
        [campaign.id],
      );
    }

    // Development/tests and sandbox mode never call Resend; live mode uses sendResendEmail below.
    const sendAttachments = (await loadCampaignAttachmentsForSend(campaign.id)).filter(
      (file) => !isArchiveAttachmentFilename(file.filename),
    );
    let sentCount = 0;
    let failedCount = 0;
    let fromEmail = campaign.from_email;
    let replyTo = identity.replyToEmail || undefined;
    if (isLive) {
      try {
        fromEmail = enforcedFromEmail(campaign.from_email, identity);
        replyTo = enforcedReplyTo(identity);
      } catch (error) {
        return json(403, { error: error instanceof Error ? error.message : "Sender identity is not configured." });
      }
    }

    for (const contact of contacts) {
      let linkedRecipientId: string | null = null;
      const idempotencyKey = buildIdempotencyKey([
        isTestSend ? "test" : "direct",
        campaign.id,
        contact.id || contact.email,
        isTestSend ? String(Date.now()) : "launch",
      ]);
      // For launch retries, reuse an existing intent row with the same idempotency key.
      const priorIntent = !isTestSend
        ? await query<{ id: string; status: string; provider_id: string | null }>(
            `SELECT id, status, provider_id FROM messages WHERE idempotency_key = $1 LIMIT 1`,
            [idempotencyKey],
          )
        : { rows: [] as Array<{ id: string; status: string; provider_id: string | null }> };
      if (priorIntent.rows[0]?.provider_id) {
        sentCount += 1;
        continue;
      }
      const messageId = priorIntent.rows[0]?.id || makeId("msg");

      if (contact.id) {
        const existing = await query<{ id: string; status: string }>(
          `SELECT id, status FROM campaign_recipients WHERE campaign_id = $1 AND contact_id = $2`,
          [campaign.id, contact.id],
        );
        if (existing.rows[0]) {
          const prior = existing.rows[0];
          const alreadyMessaged = await query<{ id: string }>(
            `SELECT id FROM messages WHERE recipient_id = $1 LIMIT 1`,
            [prior.id],
          );
          if (alreadyMessaged.rows[0] && prior.status !== "queued" && prior.status !== "processing") {
            continue;
          }
          linkedRecipientId = prior.id;
        } else {
          const recipientId = makeId("rec");
          const inserted = await query<{ id: string }>(
            `INSERT INTO campaign_recipients
               (id, campaign_id, contact_id, email, status, message_id, provider_email_id, queued_at, sent_at)
             VALUES ($1, $2, $3, $4, 'processing', $5, NULL, NOW(), NULL)
             ON CONFLICT (campaign_id, contact_id) DO NOTHING
             RETURNING id`,
            [recipientId, campaign.id, contact.id, contact.email, messageId],
          );
          linkedRecipientId = inserted.rows[0]?.id ?? null;
          if (!linkedRecipientId) {
            const raced = await query<{ id: string; status: string }>(
              `SELECT id, status FROM campaign_recipients WHERE campaign_id = $1 AND contact_id = $2`,
              [campaign.id, contact.id],
            );
            if (!raced.rows[0]) continue;
            const racedMessage = await query<{ id: string }>(
              `SELECT id FROM messages WHERE recipient_id = $1 LIMIT 1`,
              [raced.rows[0].id],
            );
            if (racedMessage.rows[0] && raced.rows[0].status !== "queued" && raced.rows[0].status !== "processing") {
              continue;
            }
            linkedRecipientId = raced.rows[0].id;
          }
        }
      }

      const unsubscribeToken = randomBytes(24).toString("base64url");
      const unsubscribeUrl = `${config.publicUrl}/u/${unsubscribeToken}`;
      const htmlBody = renderContactTemplate(campaign.html_body, contact, unsubscribeUrl);
      const textBody = renderContactTemplate(campaign.text_body, contact, unsubscribeUrl);
      const subject = renderContactTemplate(
        isTestSend ? `[TEST] ${campaign.subject}` : campaign.subject,
        contact,
        unsubscribeUrl,
      );

      // Persist delivery intent before calling the provider.
      await query(
        `INSERT INTO messages
           (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email, reply_to_email,
            html_body, text_body, status, unsubscribe_token, created_at, idempotency_key, diagnostic_json, is_test)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'captured', $11, NOW(), $12, $13, $14)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          messageId,
          campaign.id,
          linkedRecipientId,
          contact.id,
          contact.email,
          subject,
          fromEmail,
          replyTo ?? null,
          htmlBody,
          textBody,
          unsubscribeToken,
          idempotencyKey,
          JSON.stringify({ intent: isTestSend ? "test-send" : "direct", list_unsubscribe: unsubscribeUrl }),
          isTestSend,
        ],
      );

      let providerEmail: { id: string } | null = null;
      try {
        if (isLive) {
          providerEmail = await sendResendEmail({
            to: contact.email,
            subject,
            html: htmlBody,
            text: textBody,
            fromName: campaign.from_name,
            fromEmail,
            replyTo,
            unsubscribeUrl,
            attachments: sendAttachments,
            idempotencyKey,
            tags: [
              { name: "campaign_id", value: campaign.id.slice(0, 256) },
              { name: "send_type", value: isTestSend ? "test" : "direct" },
            ],
          });
        }
      } catch (error) {
        failedCount += 1;
        const errorMessage = error instanceof Error ? error.message : "Delivery failed.";
        if (linkedRecipientId) {
          await query(
            `UPDATE campaign_recipients SET status = 'failed', error = $1 WHERE id = $2`,
            [errorMessage.slice(0, 500), linkedRecipientId],
          );
        }
        await query(
          `UPDATE messages SET status = 'failed', error = $1, diagnostic_json = $2 WHERE id = $3`,
          [errorMessage.slice(0, 500), JSON.stringify({ error: errorMessage }), messageId],
        );
        continue;
      }

      if (providerEmail) {
        await query(
          `UPDATE messages SET status = 'submitted', provider_id = $1, diagnostic_json = $2 WHERE id = $3`,
          [providerEmail.id, JSON.stringify({ provider_id: providerEmail.id, list_unsubscribe: unsubscribeUrl }), messageId],
        );
      }
      if (linkedRecipientId) {
        await query(
          `UPDATE campaign_recipients
              SET status = 'sent', message_id = $1, provider_email_id = $2, sent_at = NOW(), error = NULL
            WHERE id = $3`,
          [messageId, providerEmail?.id ?? null, linkedRecipientId],
        );
      }
      sentCount += 1;
    }

    if (campaignAction[2] === "launch") {
      await completeCampaignIfIdle(campaign.id);
    }
    await recordRequestAudit(request, auth.session.user_id, isTestSend ? "campaign_test_sent" : "campaign_launched", "campaign", campaign.id, {
      recipients: sentCount,
      failed: failedCount,
      delivery_mode: config.deliveryMode,
      is_test: isTestSend,
    });
    return json(200, { queued: sentCount, sent: sentCount, failed: failedCount });
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
  if (request.method === "POST" && route === "/contacts") {
    const auth = await requirePermission(request, "contacts.manage");
    if (auth.response) return auth.response;
    if (!hasValidCsrf(request, auth.session.csrf_token)) {
      return json(403, { error: "CSRF validation failed." });
    }

    const body = await request.json().catch(() => ({})) as {
      email?: string;
      first_name?: string;
      last_name?: string;
      consent_source?: string;
      list_id?: string;
    };
    const email = normalizeEmail(body.email ?? "");
    const firstName = (body.first_name ?? "").trim();
    const lastName = (body.last_name ?? "").trim();
    const consentSource = (body.consent_source ?? "").trim();
    if (!validEmail(email)) return json(400, { error: "Enter a valid email address." });
    if (!consentSource) return json(400, { error: "Consent source is required." });
    if (!body.list_id) return json(400, { error: "Select a destination list." });

    const list = await query(`SELECT id FROM lists WHERE id = $1`, [body.list_id]);
    if (!list.rows[0]) return json(400, { error: "The selected list does not exist." });
    const existing = await query(`SELECT id FROM contacts WHERE email = $1`, [email]);
    if (existing.rows[0]) return json(409, { error: "That email address already exists." });

    const id = `con_${randomBytes(16).toString("hex")}`;
    const suppressed = await query(`SELECT 1 FROM suppressions WHERE email = $1`, [email]);
    await query(
      `INSERT INTO contacts
         (id, email, first_name, last_name, status, consent_source, consent_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())`,
      [id, email, firstName, lastName, suppressed.rows[0] ? "suppressed" : "active", consentSource],
    );
    await query(
      `INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES ($1, $2, NOW())`,
      [body.list_id, id],
    );
    await recordRequestAudit(request, auth.session.user_id, "contact_created", "contact", id, { email, list_id: body.list_id, consent_source: consentSource });
    return json(201, { contact: { id, email, first_name: firstName, last_name: lastName } });
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
    await query(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [hashPassword(body.new_password), session.user_id],
    );
    await recordRequestAudit(request, session.user_id, "password_changed", "user", session.user_id);
    return json(200, sessionPayload({ ...session, must_change_password: false }));
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
