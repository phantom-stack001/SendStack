const state = {
  session: null,
  csrf: "",
  route: { section: "overview", id: "", params: new URLSearchParams() },
  pageKey: "",
  lists: [],
  users: [],
  roles: [],
  permissionDefinitions: [],
  summary: null,
  pollTimer: null,
  renderToken: 0,
  composerDirty: false,
  reverting: false,
  selectedContacts: new Set(),
  contactSort: { key: "created_at", dir: "desc" },
  campaignStatus: "",
  lastFocus: null,
  drawerFocus: null,
};

const cache = new Map();
const PROVIDER_HOURLY_CAP = 500;

const ICONS = {
  home: '<path d="M3 9.5 10 3l7 6.5V17a1 1 0 0 1-1 1h-4.5v-5h-3v5H4a1 1 0 0 1-1-1V9.5z"/>',
  contacts: '<path d="M10 10a3 3 0 1 0-3-3 3 3 0 0 0 3 3z"/><path d="M4 16.5c.6-2.2 2.5-3.5 6-3.5s5.4 1.3 6 3.5"/>',
  campaigns: '<path d="M3 5.5h14v9H3z"/><path d="m3 6 7 5 7-5"/>',
  sending: '<circle cx="10" cy="10" r="3"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.4 4.4l1.4 1.4M14.2 14.2l1.4 1.4M15.6 4.4l-1.4 1.4M5.8 14.2l-1.4 1.4"/>',
  deliveries: '<path d="M3 10h10"/><path d="m10 6 4 4-4 4"/><path d="M3 4h6M3 16h6"/>',
  mailbox: '<path d="M3 6h14v10H3z"/><path d="m3 6 7 5 7-5"/>',
  suppressions: '<circle cx="10" cy="10" r="6.5"/><path d="m5.5 5.5 9 9"/>',
  users: '<circle cx="7" cy="8" r="2"/><circle cx="13.5" cy="8.5" r="1.7"/><path d="M3.5 15c.4-2 2-3 3.5-3s3.1 1 3.5 3M12 12.2c1.3.1 2.4.8 2.8 2.3"/>',
  audit: '<path d="M6 3.5h8v13H6z"/><path d="M8 7h4M8 10h4M8 13h2"/>',
  search: '<circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
  menu: '<path d="M3 5h14M3 10h14M3 15h14"/>',
  eye: '<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2"/>',
  eyeOff: '<path d="M3 3l14 14"/><path d="M8.2 5.3A8.8 8.8 0 0 1 10 5c5 0 8 5 8 5a15 15 0 0 1-3.1 3.4M6.1 6.8C3.7 8.2 2 10 2 10s3 5 8 5a8 8 0 0 0 3-.6"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
};

const VIEW_META = {
  overview: ["Overview", "Operations"],
  contacts: ["Contacts", "Audience"],
  campaigns: ["Campaigns", "Delivery"],
  sending: ["Sending setup", "Readiness"],
  deliveries: ["Deliveries", "Outcomes"],
  mailbox: ["Mailbox", "Spacemail"],
  suppressions: ["Suppressions", "Safety"],
  users: ["Users & roles", "Access"],
  audit: ["Audit log", "Governance"],
  _ui: ["Components", "Development"],
};

const VIEW_PERMISSIONS = {
  contacts: "contacts.view",
  campaigns: "campaigns.view",
  sending: "sending.view",
  deliveries: "deliveries.view",
  mailbox: "deliveries.view",
  suppressions: "suppressions.view",
  users: "users.view",
  audit: "audit.view",
};

const ROLE_LABELS = { admin: "Administrator", marketer: "Marketer", analyst: "Analyst" };

const DELIVERY_STATUSES = [
  ["captured", "Captured", "Stored in this workspace only. No email left the app."],
  ["submitted", "Submitted", "Spacemail accepted the message over SMTP. That is not proof it reached the inbox."],
  ["failed", "Failed", "The send failed before Spacemail accepted it."],
  ["unsubscribed", "Unsubscribed", "The recipient opted out through this workspace."],
  ["suppressed", "Suppressed", "Skipped because the address is on the suppression list."],
];

const FILTER_STATUSES = ["captured", "submitted", "failed", "unsubscribed", "suppressed"];

const CAMPAIGN_STATUSES = ["draft", "sending", "paused", "completed", "cancelled", "failed", "submission_unknown", "reconciling", "partially_sent", "cancel_requested"];

const PERMISSION_GROUPS = [
  ["Audience", ["lists.view", "lists.manage", "contacts.view", "contacts.manage", "contacts.edit"]],
  ["Campaigns", ["campaigns.view", "campaigns.manage", "campaigns.send"]],
  ["Delivery", ["sending.view", "deliveries.view", "deliveries.feedback", "suppressions.view", "suppressions.manage"]],
  ["Governance", ["overview.view", "audit.view", "users.view", "users.manage"]],
];

const PLACEHOLDER_PATTERNS = [
  [/replace this (text|copy|section)/i, "placeholder copy"],
  [/write your message/i, "placeholder message prompt"],
  [/lorem ipsum/i, "lorem ipsum"],
  [/todo:\s*replace/i, "a todo placeholder"],
  [/sample (subject|message|campaign)/i, "sample seed content"],
];

const contentModes = [
  { id: "rich_text", title: "Rich text" },
  { id: "visual", title: "Template" },
  { id: "plain_text", title: "Plain text" },
  { id: "custom_html", title: "HTML" },
];

const emptyVisual = {
  schema_version: 1,
  template: "announcement",
  brand_name: "CTN",
  preheader: "",
  headline: "",
  body: "",
  cta_label: "",
  cta_url: "",
  accent_color: "#0f7a72",
  footer: "",
};

const starterRich = "<p>Share the update here.</p>";
const starterPlain = "Share the update here.";
const starterHtml = `<!doctype html><html><body style="margin:0;background:#f4f7f8;font-family:Arial,sans-serif;color:#141821"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" style="max-width:600px;background:#ffffff"><tr><td style="padding:28px;background:#0f7a72;color:#ffffff;font-size:20px">CTN</td></tr><tr><td style="padding:32px"><h1>Share the update here.</h1><p><a href="https://ctn-sk.com">Learn more</a></p></td></tr></table></td></tr></table></body></html>`;

function icon(name) {
  return `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

function can(permission) {
  return Boolean(state.session?.permissions?.includes(permission));
}

function isLive(mode = state.session?.delivery_mode) {
  return mode === "smtp";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function titleCase(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function initials(name) {
  return String(name || "CT").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "CT";
}

function personLabel(user) {
  const role = user?.role_label || ROLE_LABELS[user?.role] || titleCase(user?.role || "");
  const name = String(user?.name || "").trim();
  const generic = !name || name.toLowerCase() === role.toLowerCase() || name.toLowerCase() === String(user?.role || "").toLowerCase();
  const primary = generic ? (user?.email || "Signed in") : name;
  return { primary, secondary: role, initials: initials(primary) };
}

function absoluteTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(date);
}

function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return absoluteTime(value);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (Math.abs(minutes) < 1) return "Just now";
  if (Math.abs(minutes) < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours} hour${Math.abs(hours) === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 14) return `${days} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  return absoluteTime(value);
}

function timeHtml(value, { relative = false } = {}) {
  if (!value) return "—";
  const abs = absoluteTime(value);
  const label = relative ? relativeTime(value) : abs;
  return `<time datetime="${escapeHtml(value)}" title="${escapeHtml(abs)}">${escapeHtml(label)}</time>`;
}

function dayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown day";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function formatIp(ip) {
  if (!ip || ip === "unknown") return "";
  if (["::1", "127.0.0.1", "0:0:0:0:0:0:0:1", "localhost"].includes(ip)) return "Local / server";
  return ip;
}

function formatByteSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast${type === "error" ? " error" : ""}`;
  item.textContent = message;
  document.querySelector("#toast-region").append(item);
  setTimeout(() => item.remove(), 4200);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-loading", busy);
  button.setAttribute("aria-busy", busy ? "true" : "false");
}

function setRefreshing(on) {
  const node = document.querySelector("#refresh-indicator");
  if (node) node.hidden = !on;
}

function setLoading() {
  document.querySelector("#content").innerHTML = `<div class="loading-grid" aria-busy="true" aria-label="Loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
}

async function api(path, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  const isFormData = typeof FormData !== "undefined" && request.body instanceof FormData;
  if (request.body && typeof request.body !== "string" && !isFormData) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(request.body);
  }
  if (request.method && request.method !== "GET" && state.csrf) request.headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(path, request);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (response.status === 401 && path !== "/api/auth/login") {
    showLogin();
    throw new Error("Your session has ended. Sign in again.");
  }
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

async function submitForm(form, request, successMessage) {
  const error = form.querySelector("[data-form-error]") || form.querySelector(".form-error");
  const submit = form.querySelector('[type="submit"]');
  if (error) error.textContent = "";
  setBusy(submit, true);
  try {
    const result = await request();
    if (successMessage) toast(successMessage);
    return result;
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
    else toast(requestError.message, "error");
    return null;
  } finally {
    setBusy(submit, false);
  }
}

function invalidate(prefix) {
  for (const key of [...cache.keys()]) if (String(key).startsWith(prefix)) cache.delete(key);
}

function safeContentObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) { /* legacy content */ }
  }
  return { schema_version: 1 };
}

function safeComposerUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url === "{{unsubscribe_url}}" || url.startsWith("#")) return url;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : "";
  } catch (_) {
    return "";
  }
}

function sanitizeRichHtml(markup) {
  const template = document.createElement("template");
  template.innerHTML = String(markup || "");
  const allowed = new Set(["P", "DIV", "BR", "H1", "H2", "H3", "STRONG", "B", "EM", "I", "U", "UL", "OL", "LI", "A", "BLOCKQUOTE", "SPAN"]);
  [...template.content.querySelectorAll("*")].forEach((node) => {
    if (!allowed.has(node.tagName)) {
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "SVG"].includes(node.tagName)) node.remove();
      else node.replaceWith(...node.childNodes);
      return;
    }
    const originalHref = node.tagName === "A" ? node.getAttribute("href") : "";
    [...node.attributes].forEach((attribute) => node.removeAttribute(attribute.name));
    if (node.tagName === "A") {
      const href = safeComposerUrl(originalHref || "");
      if (href) {
        node.setAttribute("href", href);
        node.setAttribute("rel", "noopener");
      }
    }
  });
  return template.innerHTML;
}

function richHtmlToText(markup) {
  const container = document.createElement("div");
  container.innerHTML = sanitizeRichHtml(markup).replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(p|div|h1|h2|h3|li|blockquote)>/gi, "\n");
  return (container.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function visualEmailContent(input) {
  const data = { ...emptyVisual, ...(input || {}), schema_version: 1 };
  const accent = /^#[0-9a-f]{6}$/i.test(data.accent_color || "") ? data.accent_color : "#0f7a72";
  const paragraphs = escapeHtml(data.body || "").split(/\n{2,}/).filter(Boolean).map((paragraph) => `<p style="margin:0 0 16px;color:#3d4a5c;line-height:1.65">${paragraph.replaceAll("\n", "<br>")}</p>`).join("");
  const ctaUrl = safeComposerUrl(data.cta_url);
  const cta = data.cta_label && ctaUrl ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">${escapeHtml(data.cta_label)}</a>` : "";
  const footerCell = data.footer
    ? `<tr><td style="padding:21px 30px;background:#f7f9fc;color:#3d4a5c;font-size:12px;line-height:1.6">${escapeHtml(data.footer)}</td></tr>`
    : "";
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f4f7f8;font-family:Arial,sans-serif;color:#141821"><div style="max-height:0;overflow:hidden;color:#f4f7f8">${escapeHtml(data.preheader || "")}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" style="max-width:600px;background:#ffffff"><tr><td style="padding:26px 30px;background:${accent};color:#ffffff;font-size:20px;font-weight:bold">${escapeHtml(data.brand_name || "CTN")}</td></tr><tr><td style="padding:34px 30px"><h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">${escapeHtml(data.headline || "")}</h1>${paragraphs}${cta}</td></tr>${footerCell}</table></td></tr></table></body></html>`;
  const textParts = [data.brand_name, data.headline, data.body, data.cta_label && ctaUrl ? `${data.cta_label}: ${ctaUrl}` : "", data.footer];
  return { html_body: htmlBody, text_body: textParts.filter(Boolean).join("\n\n"), content_json: data };
}

function richEmailContent(input) {
  const richHtml = sanitizeRichHtml(input?.rich_html || "");
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f4f7f8;font-family:Arial,sans-serif;color:#141821"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" style="max-width:600px;background:#ffffff"><tr><td style="padding:34px 30px;line-height:1.65">${richHtml}</td></tr></table></td></tr></table></body></html>`;
  const text = richHtmlToText(richHtml);
  return { html_body: htmlBody, text_body: text, content_json: { schema_version: 1, rich_html: richHtml } };
}

function plainEmailContent(input) {
  const text = String(input?.plain_text || "").trim();
  // Plain-text mode sends text only — same as Spacemail webmail plain compose.
  return { html_body: "", text_body: text, content_json: { schema_version: 1, plain_text: text } };
}

function buildCampaignContent(mode, draft) {
  if (mode === "visual") return visualEmailContent(draft);
  if (mode === "rich_text") return richEmailContent(draft);
  if (mode === "plain_text") return plainEmailContent(draft);
  const html = String(draft?.html_body || "");
  const text = String(draft?.text_body || "").trim();
  return { html_body: html, text_body: text, content_json: { schema_version: 1 } };
}

function contentModeLabel(mode) {
  return contentModes.find((entry) => entry.id === mode)?.title || titleCase(mode || "campaign");
}

function statusMeaning(status) {
  const found = DELIVERY_STATUSES.find(([id]) => id === String(status || "").toLowerCase());
  if (found) return found[2];
  if (status === "sandboxed") return DELIVERY_STATUSES[0][2];
  if (status === "paused") return "Launch is paused. Unsent recipients will not be submitted.";
  if (status === "cancelled") return "Unsent recipients were cancelled. Mail already accepted cannot be recalled.";
  if (status === "draft") return "Not sent.";
  return "";
}

function statusLabel(status) {
  const safe = String(status || "unknown").toLowerCase();
  const map = {
    sandboxed: "Captured", captured: "Captured", submitted: "Submitted", delivered: "Delivered", delayed: "Delayed",
    bounced: "Bounced", complained: "Complained", suppressed: "Suppressed", unsubscribed: "Unsubscribed",
    queued: "Queued", processing: "Processing", sending: "Sending", paused: "Paused", cancelled: "Cancelled",
    completed: "Completed", draft: "Draft", failed: "Failed", active: "Active",
    inactive: "Disabled", disabled: "Disabled", manual: "Manual", hard_bounce: "Hard bounce", complaint: "Complaint",
    unsubscribe: "Unsubscribed", submission_unknown: "Submission unknown", reconciling: "Reconciling",
    partially_sent: "Partly sent", cancel_requested: "Cancel requested",
  };
  return map[safe] || titleCase(safe);
}

function statusPill(status) {
  const safe = String(status || "unknown").toLowerCase();
  const tip = statusMeaning(safe);
  return `<span class="status ${escapeHtml(safe)}"${tip ? ` title="${escapeHtml(tip)}"` : ""}>${escapeHtml(statusLabel(safe))}</span>`;
}

function deliveryLegend() {
  const items = DELIVERY_STATUSES.filter(([id]) => FILTER_STATUSES.includes(id));
  return `<details class="panel" style="margin-bottom:16px"><summary class="panel-head"><span>What do statuses mean?</span></summary><div class="panel-body stack">${items.map(([status, , meaning]) => `<div class="check">${statusPill(status)}<span>${escapeHtml(meaning)}</span></div>`).join("")}<p class="help">Spacemail does not report inbox delivery, bounces, or complaints back to this workspace.</p></div></details>`;
}

const AUDIT_DETAIL_OMIT = new Set(["ip", "user_agent"]);
const AUDIT_DETAIL_ORDER = ["email", "name", "role", "active", "status", "recipients", "reason", "consent_source", "content_mode", "delivery_mode"];

function formatAuditDetailValue(key, value) {
  if (value === null || value === undefined || value === "") return null;
  if (key === "role") return ROLE_LABELS[String(value)] || titleCase(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function formatAuditDetail(detail) {
  const source = detail && typeof detail === "object" ? detail : {};
  const seen = new Set();
  const parts = [];
  for (const key of [...AUDIT_DETAIL_ORDER, ...Object.keys(source).sort()]) {
    if (seen.has(key) || AUDIT_DETAIL_OMIT.has(key) || !(key in source)) continue;
    seen.add(key);
    const formatted = formatAuditDetailValue(key, source[key]);
    if (formatted === null) continue;
    parts.push(`${titleCase(key)}: ${formatted}`);
  }
  const rawIp = typeof source.ip === "string" ? source.ip : "";
  return { primary: parts.join(" · ") || "—", ip: rawIp && rawIp !== "unknown" ? rawIp : "" };
}

const AUDIT_ACTION_OPTIONS = [
  ["", "All actions"],
  ["login_succeeded", "Signed in"],
  ["login_failed", "Sign-in failed"],
  ["logout", "Signed out"],
  ["password_changed", "Password changed"],
  ["user_created", "User created"],
  ["user_access_updated", "Access updated"],
  ["user_deleted", "User deleted"],
  ["user_password_reset", "Password reset"],
  ["list_created", "List created"],
  ["list_updated", "List updated"],
  ["list_deleted", "List deleted"],
  ["contact_created", "Contact created"],
  ["contact_updated", "Contact updated"],
  ["contact_deleted", "Contact deleted"],
  ["contacts_imported", "Contacts imported"],
  ["campaign_created", "Campaign created"],
  ["campaign_updated", "Campaign updated"],
  ["campaign_deleted", "Campaign deleted"],
  ["campaign_attachment_added", "Attachment added"],
  ["campaign_attachment_deleted", "Attachment removed"],
  ["campaign_launched", "Campaign launched"],
  ["campaign_test_sent", "Test send"],
  ["campaign_paused", "Campaign paused"],
  ["campaign_resumed", "Campaign resumed"],
  ["suppression_created", "Suppression added"],
  ["suppression_deleted", "Suppression removed"],
  ["suppression_reconsent_removed", "Suppression removed"],
  ["suppression_removed", "Suppression removed"],
  ["contact_updated", "Contact updated"],
  ["message_deleted", "Delivery deleted"],
  ["message_feedback_simulated", "Delivery feedback"],
];
const AUDIT_ACTION_LABELS = Object.fromEntries(AUDIT_ACTION_OPTIONS.filter(([value]) => value));
const AUDIT_ENTITY_OPTIONS = ["", "authentication", "session", "user", "list", "contact", "campaign", "suppression", "message"].map((value) => [value, value ? titleCase(value) : "All records"]);

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[String(action ?? "")] || titleCase(action);
}

function searchField(id, label, value, placeholder) {
  return `<div class="search">${icon("search")}<input id="${id}" type="search" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(label)}" /></div>`;
}

function optionsHtml(pairs, selected) {
  return pairs.map(([value, label]) => `<option value="${escapeHtml(value)}" ${String(value) === String(selected) ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function listOptions(lists, selected = "") {
  return (lists || []).map((list) => `<option value="${escapeHtml(list.id)}" ${list.id === selected ? "selected" : ""}>${escapeHtml(list.name)} (${Number(list.contact_count || 0)})</option>`).join("");
}

function readRoute() {
  const raw = (location.hash || "#/overview").replace(/^#/, "");
  const [pathPart, query = ""] = raw.split("?");
  const parts = pathPart.replace(/^\//, "").split("/").filter(Boolean);
  return {
    section: parts[0] || "overview",
    id: parts[1] ? decodeURIComponent(parts[1]) : "",
    params: new URLSearchParams(query),
  };
}

function pageKey(route) {
  if (route.section === "campaigns") return `campaigns:${route.id || "list"}`;
  if (route.section === "contacts") return `contacts:${route.params.get("q") || ""}:${route.params.get("list") || ""}`;
  if (route.section === "deliveries") return `deliveries:${route.params.toString()}`;
  if (route.section === "audit") return `audit:${route.params.toString()}`;
  if (route.section === "suppressions") return `suppressions:${route.params.toString()}`;
  return route.section;
}

function hashFor(section, id = "", params = null) {
  const path = id ? `/${section}/${encodeURIComponent(id)}` : `/${section}`;
  const query = params && [...params.keys()].length ? `?${params.toString()}` : "";
  return `#${path}${query}`;
}

function isLocalHost() {
  return ["localhost", "127.0.0.1"].includes(location.hostname);
}

function go(section, id = "", params = null, fresh = false) {
  if (fresh) state.pageKey = "";
  const next = hashFor(section, id, params);
  if (location.hash === next) onRoute();
  else location.hash = next;
}

function setChrome(section, title) {
  const [base, kicker] = VIEW_META[section] || ["CTN", ""];
  const shown = title || base;
  const titleNode = document.querySelector("#page-title");
  const kickerNode = document.querySelector("#page-kicker");
  if (titleNode) titleNode.textContent = shown;
  if (kickerNode) kickerNode.textContent = kicker;
  document.title = section === "login" ? "Sign in · CTN" : `${shown} · CTN`;
  document.querySelectorAll("#main-nav [data-view]").forEach((link) => {
    if (link.dataset.view === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function updatePrimaryAction() {
  const button = document.querySelector("#global-new-campaign");
  if (!button) return;
  const allowed = can("campaigns.manage");
  button.disabled = !allowed;
  button.setAttribute("aria-disabled", allowed ? "false" : "true");
  button.setAttribute("aria-label", allowed ? "New campaign" : "New campaign, not available for your role");
}

function updateStatus(summary = state.summary) {
  const button = document.querySelector("#status-button");
  const pop = document.querySelector("#status-popover");
  if (!button || !summary) return;
  const queued = Number(summary.counts?.queued || 0);
  const sent = Number(summary.counts?.sent_today || 0);
  const limit = Number(summary.daily_limit || state.session?.daily_limit || 0);
  const remaining = Math.max(0, limit - sent);
  const live = isLive(summary.delivery_mode);
  const sending = live && queued > 0;
  button.dataset.state = sending ? "sending" : live ? "live" : "preview";
  document.querySelector("#status-label").textContent = sending ? "Sending" : live ? "Live" : "Preview";
  const setup = can("sending.view") ? `<a href="#/sending">Review sending setup</a>` : "";
  pop.innerHTML = `
    <strong>${sending ? "A campaign is sending" : live ? "Live delivery is on" : "Preview"}</strong>
    <p>${live ? "Submitted means the sending service accepted the message. It does not prove inbox placement." : "Campaigns stay in this workspace. Nothing is mailed out."}</p>
    <p class="nums">Queue: ${queued.toLocaleString()}</p>
    <p class="nums">Today: ${sent.toLocaleString()} of ${limit.toLocaleString()} · ${remaining.toLocaleString()} remaining</p>
    ${setup}`;
}

function showLogin() {
  state.session = null;
  state.csrf = "";
  clearTimeout(state.pollTimer);
  document.querySelector("#app-shell").hidden = true;
  document.querySelector("#login-screen").hidden = false;
  setNav(false);
  document.title = "Sign in · CTN";
  document.querySelector(".skip-link")?.setAttribute("href", "#login-email");
  document.querySelector("#login-email")?.focus();
}

function showApp(sessionData) {
  state.session = sessionData;
  state.csrf = sessionData.csrf_token;
  document.querySelector("#login-screen").hidden = true;
  document.querySelector("#app-shell").hidden = false;
  document.querySelector(".skip-link")?.setAttribute("href", "#content");
  const identity = personLabel(sessionData.user);
  document.querySelector("#user-name").textContent = identity.primary;
  document.querySelector("#user-role").textContent = identity.secondary;
  document.querySelector("#user-initials").textContent = identity.initials;
  updatePrimaryAction();
  if (sessionData.must_change_password || sessionData.user?.must_change_password) {
    openChangePassword(true);
    return;
  }
  schedulePoll(0);
  if (!location.hash) history.replaceState(null, "", "#/overview");
  onRoute();
}

function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  if (!state.session) return;
  state.pollTimer = setTimeout(async () => {
    if (!state.session || document.hidden) return;
    try {
      const summary = await api("/api/summary");
      state.summary = summary;
      cache.set("summary", summary);
      updateStatus(summary);
    } catch (_) { /* quiet */ }
    const queued = Number(state.summary?.counts?.queued || 0);
    schedulePoll(queued > 0 ? 5000 : 20000);
  }, delay);
}

function onRoute() {
  const route = readRoute();
  if (state.reverting) {
    state.reverting = false;
    return;
  }
  const nextKey = pageKey(route);
  if (state.composerDirty && nextKey !== state.pageKey) {
    if (!window.confirm("You have unsaved changes to this campaign. Leave without saving them?")) {
      state.reverting = true;
      history.back();
      return;
    }
    state.composerDirty = false;
  }
  const same = nextKey === state.pageKey && state.session;
  state.route = route;
  setNav(false);
  if (!state.session) {
    if (route.section === "_ui" && isLocalHost()) {
      document.querySelector("#login-screen").hidden = true;
      document.querySelector("#app-shell").hidden = false;
      renderKit();
    } else showLogin();
    return;
  }
  if (!same) {
    state.pageKey = nextKey;
    renderSection(route);
  } else if (route.section !== "campaigns") {
    syncOverlay(route);
    setChrome(route.section);
  }
}

async function renderSection(route) {
  clearInterval(state.composerClock);
  const token = ++state.renderToken;
  closeDrawer({ skipHash: true });
  setChrome(route.section, route.section === "campaigns" && route.id ? (route.id === "new" ? "New campaign" : "Campaign") : "");
    if (route.section === "_ui") {
    if (!isLocalHost()) {
      document.querySelector("#content").innerHTML = `<section class="panel empty-state"><div><h2>Not available</h2><p>The component reference is only on a local development host.</p></div></section>`;
      return;
    }
    renderKit();
    return;
  }
  if (!VIEW_META[route.section]) {
    go("overview");
    return;
  }
  const permission = VIEW_PERMISSIONS[route.section];
  if (permission && !can(permission)) {
    renderDenied(route.section);
    return;
  }
  try {
    if (route.section === "campaigns" && route.id) await renderComposer(route.id === "new" ? null : route.id, token);
    else if (route.section === "overview") await renderOverview(token);
    else if (route.section === "contacts") await renderContacts(token);
    else if (route.section === "campaigns") await renderCampaigns(token);
    else if (route.section === "sending") await renderSending(token);
    else if (route.section === "deliveries") await renderDeliveries(token);
    else if (route.section === "mailbox") await renderMailbox(token);
    else if (route.section === "suppressions") await renderSuppressions(token);
    else if (route.section === "users") await renderUsers(token);
    else if (route.section === "audit") await renderAudit(token);
    if (token !== state.renderToken) return;
    if (route.id && !["campaigns", "overview", "sending", "audit", "suppressions"].includes(route.section)) syncOverlay(route);
  } catch (error) {
    if (token !== state.renderToken) return;
    setRefreshing(false);
    const content = document.querySelector("#content");
    if (content.querySelector(".stat-grid, table, .panel")) {
      toast(error.message, "error");
      return;
    }
    content.innerHTML = `<div class="notice warning"><div><strong>Couldn’t load this view.</strong><p>${escapeHtml(error.message)}</p></div></div>`;
  }
}

function renderDenied(section) {
  const role = personLabel(state.session?.user || {}).secondary || "this role";
  const name = VIEW_META[section]?.[0] || "This section";
  document.querySelector("#content").innerHTML = `<section class="panel empty-state"><div><h2>${escapeHtml(name)} is not available for ${escapeHtml(role)}</h2><p>Your role does not include this record. Overview stays available. An administrator can change access from Users &amp; roles.</p></div></section>`;
}

function syncOverlay(route) {
  if (!route.id) {
    closeDrawer({ skipHash: true });
    return;
  }
  if (route.section === "contacts") openContactDetail(route.id);
  if (route.section === "deliveries") openDelivery(route.id);
  if (route.section === "mailbox" && route.id) openMailboxMessage(route.id);
  if (route.section === "users") openManageUser(route.id);
}

function paintOverview(data, lists = state.lists) {
  if (!data) return;
  const remaining = Math.max(0, Number(data.daily_limit) - Number(data.counts.sent_today));
  const contacts = Number(data.counts.contacts || 0);
  const card = (href, label, value, detail, allowed) => allowed
    ? `<a class="stat-card" href="${href}"><span class="stat-label">${label}</span><strong class="stat-value nums">${value}</strong><span class="stat-detail">${detail}</span></a>`
    : `<article class="stat-card"><span class="stat-label">${label}</span><strong class="stat-value nums">${value}</strong><span class="stat-detail">${detail}</span></article>`;
  const checklist = contacts === 0 ? renderChecklist(data, lists) : "";
  document.querySelector("#content").innerHTML = `
    ${checklist}
    <section class="stat-grid" aria-label="Delivery overview">
      ${card("#/contacts", "Active contacts", contacts.toLocaleString(), "Eligible to include in a campaign", can("contacts.view"))}
      ${card("#/deliveries", "Sent today", Number(data.counts.sent_today || 0).toLocaleString(), `${remaining.toLocaleString()} remaining today`, can("deliveries.view"))}
      ${card("#/campaigns", "Queue", Number(data.counts.queued || 0).toLocaleString(), Number(data.counts.queued) ? "Waiting to send" : "Nothing waiting", can("campaigns.view"))}
      ${card("#/suppressions", "Suppressed", Number(data.counts.suppressed || 0).toLocaleString(), "Excluded from every campaign", can("suppressions.view"))}
    </section>
    <div class="two-column">
      <section class="panel">
        <div class="panel-head"><div><h2>Recent campaigns</h2><p>Latest campaigns and their state</p></div><a class="button small ghost" href="#/campaigns">View all</a></div>
        ${renderRecentCampaigns(data.recent_campaigns || [])}
      </section>
      ${can("deliveries.view") ? `<section class="panel"><div class="panel-head"><div><h2>Latest deliveries</h2><p>One row is one email to one recipient</p></div><a class="button small ghost" href="#/deliveries">View deliveries</a></div><div class="panel-body">${renderRecentDeliveries(data.recent_messages || [])}</div></section>` : `<section class="panel"><div class="panel-body"><h2>Recipient data is protected</h2><p class="help">The Analyst role includes campaign totals without contact addresses or message contents.</p></div></section>`}
    </div>`;
}

function renderChecklist(data, lists) {
  const hasLists = (lists || []).length > 0;
  const hasCampaigns = (data.recent_campaigns || []).length > 0;
  const hasDeliveries = (data.recent_messages || []).length > 0;
  const step = (done, label, href) => `<li>${href && !done ? `<a href="${href}">${done ? "Done" : "To do"} · ${label}</a>` : `<span class="${done ? "done" : ""}">${done ? "Done" : "To do"} · ${label}</span>`}</li>`;
  return `<section class="panel" style="margin-bottom:24px"><div class="panel-head"><div><h2>Get started</h2><p>Create an audience before the first campaign.</p></div></div><div class="panel-body"><ol class="checklist">
    ${step(hasLists, "Create a list", can("lists.manage") ? "#/contacts" : "")}
    ${step(false, "Add or import contacts", can("contacts.manage") ? "#/contacts" : "")}
    ${step(hasCampaigns, "Compose a campaign", can("campaigns.manage") ? "#/campaigns/new" : "#/campaigns")}
    ${step(hasDeliveries, "Send a test", can("campaigns.send") ? "#/campaigns" : "")}
    ${step(false, "Launch to the audience", "")}
  </ol></div></section>`;
}

function renderRecentCampaigns(campaigns) {
  if (!campaigns.length) return `<div class="empty-state"><div><h2>No campaigns yet</h2><p>${can("campaigns.manage") ? "Use New campaign once a list has contacts." : "Campaigns will appear here after someone creates one."}</p></div></div>`;
  return `<div class="table-wrap"><table class="responsive"><thead><tr><th>Campaign</th><th>Status</th><th>Submitted</th><th>Issues</th></tr></thead><tbody>${campaigns.map((campaign) => {
    const recipients = Number(campaign.recipients || 0);
    const submitted = Number(campaign.submitted ?? campaign.sent ?? 0);
    return `<tr><td data-label="Campaign"><strong>${escapeHtml(campaign.name)}</strong><span class="subtext">${escapeHtml(campaign.subject || "")}</span></td><td data-label="Status">${statusPill(campaign.status)}</td><td data-label="Submitted" class="nums">${submitted}/${recipients}</td><td data-label="Issues" class="nums">${Number(campaign.issues || 0)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderRecentDeliveries(messages) {
  if (!messages.length) return `<div class="empty-state"><div><p>Deliveries appear here after a test or a launch.</p></div></div>`;
  return `<div class="stack">${messages.map((message) => `<div><strong class="email">${escapeHtml(message.to_email)}</strong><p class="help">${escapeHtml(message.subject || "")} · ${timeHtml(message.created_at, { relative: true })}</p></div>`).join("")}</div>`;
}

async function renderOverview(token) {
  if (cache.get("summary")) paintOverview(cache.get("summary"), state.lists);
  else setLoading();
  setRefreshing(Boolean(cache.get("summary")));
  const summary = await api("/api/summary");
  if (token !== state.renderToken) return;
  let lists = state.lists;
  if (can("lists.view")) {
    try { lists = (await api("/api/lists")).lists || []; state.lists = lists; } catch (_) { lists = []; }
  }
  if (token !== state.renderToken) return;
  cache.set("summary", summary);
  state.summary = summary;
  updateStatus(summary);
  paintOverview(summary, lists);
  setRefreshing(false);
}

async function getLists(force = false) {
  if (!force && state.lists.length) return state.lists;
  if (!can("lists.view")) return [];
  state.lists = (await api("/api/lists")).lists || [];
  return state.lists;
}

async function renderContacts(token) {
  const params = state.route.params;
  const query = params.get("q") || "";
  const listId = params.get("list") || "";
  const key = `contacts:${query}:${listId}`;
  const cachedContacts = cache.get(key);
  if (cachedContacts) paintContacts(cachedContacts, cachedContacts.lists || state.lists, query, listId);
  else setLoading();
  setRefreshing(Boolean(cachedContacts));
  const search = new URLSearchParams();
  if (query) search.set("q", query);
  if (listId) search.set("list_id", listId);
  const [data, lists] = await Promise.all([
    api(`/api/contacts${search.toString() ? `?${search}` : ""}`),
    getLists(),
  ]);
  if (token !== state.renderToken) return;
  cache.set(key, { ...data, lists });
  paintContacts(data, lists, query, listId);
  setRefreshing(false);
}

function paintContacts(data, lists, query, listId) {
  const canManage = can("contacts.manage");
  const canEdit = can("contacts.edit");
  let contacts = [...(data.contacts || [])];
  const { key, dir } = state.contactSort;
  contacts.sort((a, b) => {
    const left = String(a[key] || "").toLowerCase();
    const right = String(b[key] || "").toLowerCase();
    return left < right ? (dir === "asc" ? -1 : 1) : left > right ? (dir === "asc" ? 1 : -1) : 0;
  });
  const activeCount = contacts.filter((contact) => contact.status === "active").length;
  const suppressedCount = contacts.filter((contact) => contact.status === "suppressed").length;
  const sortBtn = (id, label) => `<button type="button" data-sort="${id}" aria-sort="${state.contactSort.key === id ? (state.contactSort.dir === "asc" ? "ascending" : "descending") : "none"}">${label}</button>`;
  const rows = contacts.map((contact) => {
    const email = contact.email || "";
    const checked = state.selectedContacts.has(contact.id) ? "checked" : "";
    return `<tr>
      ${canEdit ? `<td data-label="Select"><input type="checkbox" data-select-contact="${escapeHtml(contact.id)}" ${checked} aria-label="Select ${escapeHtml(email)}" /></td>` : ""}
      <td data-label="Contact"><div class="contact-identity"><span class="avatar" aria-hidden="true">${escapeHtml(initials(email))}</span><div><strong class="email">${escapeHtml(email)}</strong></div></div></td>
      <td data-label="Lists">${escapeHtml(contact.lists || "—")}</td>
      <td data-label="Status">${statusPill(contact.status)}</td>
      <td data-label="Added">${timeHtml(contact.created_at)}</td>
      <td class="table-actions" data-label="Actions"><a class="button small ghost" href="#/contacts/${encodeURIComponent(contact.id)}">View</a>${canEdit ? `<button type="button" class="button small ghost" data-edit-contact="${escapeHtml(contact.id)}">Edit</button>` : ""}</td>
    </tr>`;
  }).join("");
  const empty = query || listId
    ? `<div class="empty-state"><div><h2>No matching contacts</h2><p>Try another email or list.</p><a class="button" href="#/contacts">Clear filters</a></div></div>`
    : `<div class="empty-state"><div><h2>No contacts yet</h2><p>${canManage ? "Import a CSV or add a contact from the header." : "Contacts will appear here after they are added."}</p></div></div>`;
  const rail = [`<a href="#/contacts" ${listId ? "" : 'aria-current="true"'}>All contacts</a>`, ...(lists || []).map((list) => `<a href="#/contacts?list=${encodeURIComponent(list.id)}" ${list.id === listId ? 'aria-current="true"' : ""}>${escapeHtml(list.name)} <span class="nums">${Number(list.contact_count || 0)}</span></a>`)].join("");
  document.querySelector("#content").innerHTML = `
    <div class="section-lead"><div><h2 class="nums">${contacts.length.toLocaleString()} ${contacts.length === 1 ? "contact" : "contacts"}</h2><p>${contacts.length === 500 ? "Showing the 500 most recent matches." : "People you can email through Spacemail."}</p></div>
      ${canManage ? `<div class="section-actions"><button type="button" class="button" id="import-contacts">Import CSV</button><button type="button" class="button primary" id="add-contact">Add contact</button></div>` : ""}</div>
    <div class="contacts-layout">
      <aside class="list-rail" aria-label="Lists">${rail}${can("lists.manage") ? `<button type="button" id="create-list">+ New list</button>` : (lists || []).length ? "" : `<span class="help">No lists yet</span>`}</aside>
      <div>
        <div class="contacts-stats"><span>Active <strong>${activeCount.toLocaleString()}</strong></span><span>Suppressed <strong>${suppressedCount.toLocaleString()}</strong></span><span>Lists <strong>${(lists || []).length.toLocaleString()}</strong></span>${canEdit && state.selectedContacts.size ? `<button type="button" class="button small danger" id="delete-selected">Delete ${state.selectedContacts.size} selected</button>` : ""}</div>
        <div class="toolbar">${searchField("contact-search", "Search contacts", query, "Search by email")}</div>
        <section class="panel">${contacts.length ? `<div class="table-wrap"><table class="responsive contacts-table"><thead><tr>${canEdit ? `<th></th>` : ""}<th>${sortBtn("email", "Contact")}</th><th>Lists</th><th>${sortBtn("status", "Status")}</th><th>${sortBtn("created_at", "Added")}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : empty}</section>
      </div>
    </div>`;
  const search = document.querySelector("#contact-search");
  let timer;
  search?.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = new URLSearchParams(state.route.params);
      const value = search.value.trim();
      if (value) next.set("q", value); else next.delete("q");
      go("contacts", "", next);
    }, 280);
  });
  if (query) {
    search?.focus();
    search?.setSelectionRange(query.length, query.length);
  }
  document.querySelector("#add-contact")?.addEventListener("click", () => openContactModal(null, listId));
  document.querySelector("#import-contacts")?.addEventListener("click", () => openImportModal(listId));
  document.querySelector("#create-list")?.addEventListener("click", openListModal);
  document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
    const sortKey = button.dataset.sort;
    state.contactSort = { key: sortKey, dir: state.contactSort.key === sortKey && state.contactSort.dir === "asc" ? "desc" : "asc" };
    paintContacts(data, lists, query, listId);
  }));
  document.querySelectorAll("[data-select-contact]").forEach((box) => box.addEventListener("change", () => {
    if (box.checked) state.selectedContacts.add(box.dataset.selectContact);
    else state.selectedContacts.delete(box.dataset.selectContact);
    paintContacts(data, lists, query, listId);
  }));
  document.querySelector("#delete-selected")?.addEventListener("click", async () => {
    const ids = [...state.selectedContacts];
    if (!ids.length || !window.confirm(`Delete ${ids.length} contact${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setBusy(document.querySelector("#delete-selected"), true);
    try {
      for (const id of ids) await api(`/api/contacts/${id}`, { method: "DELETE" });
      state.selectedContacts.clear();
      invalidate("contacts:");
      toast("Contacts deleted");
      go("contacts", "", state.route.params, true);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  document.querySelectorAll("[data-edit-contact]").forEach((button) => button.addEventListener("click", () => {
    const contact = contacts.find((row) => row.id === button.dataset.editContact);
    if (contact) openContactModal(contact, listId);
  }));
}

function openListModal() {
  openModal("Create list", "Audience", "sm", `
    <form id="list-form" class="stack">
      <label>List name <span class="req">Required</span><input name="name" required maxlength="120" /></label>
      <label>Description<textarea name="description" maxlength="500" placeholder="What this audience opted in to receive"></textarea></label>
      <p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create list</button></div>
    </form>`);
  document.querySelector("#list-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await submitForm(form, () => api("/api/lists", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "List created");
    if (!result) return;
    state.lists = [];
    invalidate("contacts:");
    closeModal();
    go("contacts", "", null, true);
  });
}

function openContactModal(contact = null, preferredListId = "") {
  const editing = Boolean(contact?.id);
  openModal(editing ? "Edit contact" : "Add contact", "Audience", "md", `
    <form id="contact-form" class="stack">
      <label>Email address <span class="req">Required</span><input name="email" type="email" required value="${escapeHtml(contact?.email || "")}" aria-describedby="contact-email-error" autocomplete="off" /></label>
      <p id="contact-email-error" class="form-error" role="alert"></p>
      <div id="contact-list-field"><label>List <span class="req">Required</span><select name="list_id" required disabled><option>Loading lists…</option></select></label></div>
      ${editing ? `<label>Status<select name="status"><option value="">Keep current</option><option value="active" ${contact?.status === "active" ? "selected" : ""}>Active</option><option value="suppressed" ${contact?.status === "suppressed" ? "selected" : ""}>Suppressed</option></select><span class="help">Suppressed addresses are excluded from campaigns. Use the suppressions page for bounce and complaint blocks.</span></label>` : ""}
      <p class="form-error" data-form-error role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">${editing ? "Save changes" : "Add contact"}</button></div>
    </form>`);
  const email = document.querySelector('#contact-form [name="email"]');
  email?.addEventListener("blur", () => {
    const ok = validEmail(email.value);
    email.setAttribute("aria-invalid", ok ? "false" : "true");
    document.querySelector("#contact-email-error").textContent = ok ? "" : "Enter a valid email address.";
  });
  getLists().then((lists) => {
    const field = document.querySelector("#contact-list-field");
    if (!field) return;
    const selected = contact?.list_ids?.[0] || preferredListId || lists[0]?.id || "";
    field.innerHTML = lists.length
      ? `<label>List <span class="req">Required</span><select name="list_id" required>${listOptions(lists, selected)}</select></label>`
      : `<div class="notice"><div><strong>Create a list first.</strong><p>A contact has to belong to a list.</p><button type="button" class="button" id="inline-create-list">Create a list</button></div></div>`;
    document.querySelector("#inline-create-list")?.addEventListener("click", openListModal);
  }).catch((error) => toast(error.message, "error"));
  document.querySelector("#contact-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!validEmail(form.email.value)) {
      form.email.setAttribute("aria-invalid", "true");
      document.querySelector("#contact-email-error").textContent = "Enter a valid email address.";
      return;
    }
    if (!form.list_id) return;
    const data = Object.fromEntries(new FormData(form));
    if (!editing || !data.status) delete data.status;
    const result = await submitForm(form, () => api(editing ? `/api/contacts/${contact.id}` : "/api/contacts", { method: editing ? "PATCH" : "POST", body: data }), editing ? "Contact updated" : "Contact added");
    if (!result) return;
    invalidate("contacts:");
    closeModal();
    go("contacts", "", state.route.params, true);
  });
}

async function openContactDetail(contactId) {
  openDrawer("Contact", "Audience", `<p class="help">Loading contact and send history…</p>`);
  try {
    const data = await api(`/api/contacts/${contactId}`);
    const contact = data.contact;
    const email = contact.email || "";
    const messages = Array.isArray(data.messages) ? data.messages : [];
    openDrawer(email, "Contact", `
      <dl class="message-meta">
        <dt>Email</dt><dd class="email">${escapeHtml(email)}</dd>
        <dt>Status</dt><dd>${statusPill(contact.status)}</dd>
        <dt>Lists</dt><dd>${escapeHtml(contact.lists || "—")}</dd>
        <dt>Added</dt><dd>${timeHtml(contact.created_at)}</dd>
        <dt>Updated</dt><dd>${timeHtml(contact.updated_at)}</dd>
      </dl>
      ${data.suppression ? `<div class="notice warning"><div><strong>On the suppression list.</strong><p>${escapeHtml(titleCase(data.suppression.reason))} · ${escapeHtml(titleCase(data.suppression.source))} · ${absoluteTime(data.suppression.created_at)}</p></div></div>` : `<div class="notice"><div><strong>Not suppressed.</strong><p>This address can be included in campaigns.</p></div></div>`}
      <h3>Send history</h3>
      ${messages.length ? `<div class="table-wrap"><table class="responsive"><thead><tr><th>Campaign</th><th>Subject</th><th>Status</th><th>When</th></tr></thead><tbody>${messages.map((message) => `<tr><td data-label="Campaign">${escapeHtml(message.campaign_name || "—")}</td><td data-label="Subject">${can("deliveries.view") ? `<a href="#/deliveries/${encodeURIComponent(message.id)}">${escapeHtml(message.subject || "Untitled")}</a>` : escapeHtml(message.subject || "Untitled")}</td><td data-label="Status">${statusPill(message.status)}</td><td data-label="When">${timeHtml(message.created_at, { relative: true })}</td></tr>`).join("")}</tbody></table></div>` : `<p class="help">No sends recorded for this contact yet.</p>`}
      ${can("contacts.edit") ? `<div class="form-actions"><button type="button" class="button" id="detail-edit">Edit</button><button type="button" class="button danger" id="detail-delete">Delete</button></div>` : ""}`);
    document.querySelector("#detail-edit")?.addEventListener("click", () => openContactModal(contact));
    document.querySelector("#detail-delete")?.addEventListener("click", async () => {
      if (!window.confirm(`Delete ${email}? This cannot be undone.`)) return;
      await api(`/api/contacts/${contact.id}`, { method: "DELETE" });
      invalidate("contacts:");
      toast("Contact deleted");
      go("contacts", "", state.route.params, true);
    });
  } catch (error) {
    openDrawer("Contact", "Audience", `<p class="form-error">${escapeHtml(error.message)}</p>`);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function openImportModal(preferredListId = "") {
  const draft = { step: 1, rows: [], mapping: { email: "" }, listId: preferredListId };
  const paint = () => {
    const body = document.querySelector("#import-host");
    if (!body) return;
    if (draft.step === 1) {
      body.innerHTML = `
        <p class="steps"><span class="current">1. Upload</span><span>2. Map columns</span><span>3. Confirm</span></p>
        <div id="import-list"></div>
        <label class="dropzone" id="csv-drop">Drop a CSV here, or choose a file<input id="csv-file" type="file" accept=".csv,text/csv" /></label>
        <p class="help">Use the sample if you want the expected column name. <button type="button" class="text-link" id="download-sample-csv">Download sample CSV</button></p>
        <p class="form-error" data-form-error role="alert"></p>`;
      getLists().then((lists) => {
        const host = document.querySelector("#import-list");
        if (!host) return;
        host.innerHTML = lists.length
          ? `<label>Destination list <span class="req">Required</span><select id="import-list-id" required>${listOptions(lists, draft.listId || lists[0]?.id)}</select></label>`
          : `<div class="notice"><div><strong>Create a list first.</strong><button type="button" class="button" id="import-create-list">Create a list</button></div></div>`;
        document.querySelector("#import-create-list")?.addEventListener("click", openListModal);
      });
    } else if (draft.step === 2) {
      const headers = draft.rows[0] || [];
      const select = (name) => `<select data-map="${name}"><option value="">Skip</option>${headers.map((header, index) => `<option value="${index}" ${String(draft.mapping[name]) === String(index) ? "selected" : ""}>${escapeHtml(header || `Column ${index + 1}`)}</option>`).join("")}</select>`;
      const preview = draft.rows.slice(1, 6).map((cells) => `<tr>${cells.slice(0, 4).map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
      body.innerHTML = `
        <p class="steps"><span>1. Upload</span><span class="current">2. Map columns</span><span>3. Confirm</span></p>
        <label>Email <span class="req">Required</span>${select("email")}</label>
        <div class="table-wrap"><table><tbody>${preview}</tbody></table></div>
        <p class="help">Showing the first ${Math.min(5, Math.max(0, draft.rows.length - 1))} data rows. Only the email column is imported.</p>
        <div class="form-actions"><button type="button" class="button" id="import-back">Back</button><button type="button" class="button primary" id="import-next">Continue</button></div>
        <p class="form-error" data-form-error role="alert"></p>`;
      body.querySelectorAll("[data-map]").forEach((field) => field.addEventListener("change", () => { draft.mapping[field.dataset.map] = field.value; }));
      document.querySelector("#import-back")?.addEventListener("click", () => { draft.step = 1; paint(); });
      document.querySelector("#import-next")?.addEventListener("click", () => {
        if (draft.mapping.email === "") {
          body.querySelector("[data-form-error]").textContent = "Choose the email column.";
          return;
        }
        draft.step = 3;
        paint();
      });
    } else {
      body.innerHTML = `
        <p class="steps"><span>1. Upload</span><span>2. Map columns</span><span class="current">3. Confirm</span></p>
        <p class="nums">${Math.max(0, draft.rows.length - 1).toLocaleString()} rows ready to import.</p>
        <p class="help">Imported addresses become active and can be emailed unless they are already suppressed.</p>
        <div id="import-result"></div>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="form-actions"><button type="button" class="button" id="import-back">Back</button><button type="button" class="button primary" id="import-go">Import contacts</button></div>`;
      document.querySelector("#import-back")?.addEventListener("click", () => { draft.step = 2; paint(); });
      document.querySelector("#import-go")?.addEventListener("click", () => runImport(draft));
    }
    document.querySelector("#download-sample-csv")?.addEventListener("click", () => downloadText("ctn-contacts-sample.csv", "email\nalex@example.com\n"));
    const input = document.querySelector("#csv-file");
    const drop = document.querySelector("#csv-drop");
    input?.addEventListener("change", () => acceptCsv(input.files?.[0], draft, paint));
    drop?.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("is-drag"); });
    drop?.addEventListener("dragleave", () => drop.classList.remove("is-drag"));
    drop?.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("is-drag");
      acceptCsv(event.dataTransfer.files?.[0], draft, paint);
    });
  };
  openModal("Import contacts", "CSV", "lg", `<div id="import-host"></div>`);
  paint();
}

async function acceptCsv(file, draft, paint) {
  const error = document.querySelector("#import-host [data-form-error]");
  if (!file) return;
  draft.listId = document.querySelector("#import-list-id")?.value || draft.listId;
  if (!draft.listId) {
    if (error) error.textContent = "Choose a destination list.";
    return;
  }
  draft.rows = parseCsv(await file.text());
  if (draft.rows.length < 2) {
    if (error) error.textContent = "The file needs a header row and at least one contact.";
    return;
  }
  const headers = draft.rows[0].map((header) => header.toLowerCase().replace(/\s+/g, "_"));
  draft.mapping.email = String(Math.max(0, headers.indexOf("email")));
  if (headers.indexOf("email") < 0) draft.mapping.email = "";
  draft.step = 2;
  paint();
}

async function runImport(draft) {
  const error = document.querySelector("#import-host [data-form-error]");
  const button = document.querySelector("#import-go");
  setBusy(button, true);
  try {
    const lines = ["email"];
    draft.rows.slice(1).forEach((cells) => {
      const email = cells[Number(draft.mapping.email)] || "";
      lines.push(`"${String(email).replaceAll('"', '""')}"`);
    });
    const result = await api("/api/contacts/import", { method: "POST", body: { csv_text: lines.join("\n"), list_id: draft.listId } });
    const issues = Array.isArray(result.issues) ? result.issues : [];
    document.querySelector("#import-result").innerHTML = `
      <div class="notice success"><div><strong>${Number(result.imported) || 0} imported, ${Number(result.updated) || 0} updated.</strong><p>${Number(result.duplicates) || 0} duplicates and ${Number(result.invalid) || 0} invalid rows were skipped. Addresses already suppressed are still stored as suppressed.</p></div></div>
      ${issues.length ? `<div class="table-wrap"><table><thead><tr><th>Row</th><th>Email</th><th>Reason</th></tr></thead><tbody>${issues.map((issue) => `<tr><td>${Number(issue.row) || "—"}</td><td>${escapeHtml(issue.email || "—")}</td><td>${escapeHtml(issue.reason === "invalid_email" ? "Invalid email" : issue.reason === "duplicate_in_file" ? "Duplicate in file" : (issue.reason || "Skipped"))}</td></tr>`).join("")}</tbody></table></div><button type="button" class="button" id="download-issues">Download error report</button>` : ""}`;
    document.querySelector("#download-issues")?.addEventListener("click", () => {
      const csv = ["row,email,reason", ...issues.map((issue) => `${Number(issue.row) || ""},"${String(issue.email || "").replaceAll('"', '""')}","${String(issue.reason || "").replaceAll('"', '""')}"`)].join("\n");
      downloadText("ctn-import-errors.csv", csv);
    });
    invalidate("contacts:");
    state.lists = [];
    toast("Import complete");
    state.pageKey = "";
    if (state.route.section === "contacts") onRoute();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  } finally {
    setBusy(button, false);
  }
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function renderCampaigns(token) {
  if (cache.get("campaigns")) paintCampaigns(cache.get("campaigns"));
  else setLoading();
  setRefreshing(Boolean(cache.get("campaigns")));
  const data = await api("/api/campaigns");
  if (token !== state.renderToken) return;
  cache.set("campaigns", data);
  await getLists().catch(() => []);
  if (token !== state.renderToken) return;
  paintCampaigns(data);
  setRefreshing(false);
}

function paintCampaigns(data) {
  const status = state.campaignStatus;
  const rows = (data.campaigns || []).filter((campaign) => !status || campaign.status === status);
  const statuses = [...new Set([...(data.campaigns || []).map((campaign) => campaign.status), ...CAMPAIGN_STATUSES])];
  const body = rows.map((campaign) => {
    const recipients = Number(campaign.recipients || 0);
    const queued = Number(campaign.queued || 0);
    const submitted = Number(campaign.submitted ?? campaign.sent ?? 0);
    const failed = Number(campaign.failed || 0);
    const editable = can("campaigns.manage") && (campaign.status === "draft" || (campaign.status === "paused" && can("campaigns.send")));
    const launchable = can("campaigns.send") && ["draft", "paused"].includes(campaign.status);
    const ask = can("campaigns.manage") && !can("campaigns.send") && campaign.status === "draft"
      ? `<button type="button" class="button small" disabled aria-disabled="true" title="An administrator sends tests and launches this campaign">Ask an administrator</button>`
      : "";
    return `<tr>
      <td data-label="Campaign"><strong>${escapeHtml(campaign.name)}</strong><span class="subtext">${escapeHtml(campaign.subject || "")}</span></td>
      <td data-label="Status">${statusPill(campaign.status)}</td>
      <td data-label="Audience">${escapeHtml(campaign.list_name || "—")}</td>
      <td data-label="Progress" class="nums" title="Queued ${queued} · Submitted ${submitted} · Failed ${failed}">${submitted}/${recipients}${failed ? ` · ${failed} failed` : ""}</td>
      <td data-label="Created">${timeHtml(campaign.created_at, { relative: true })}</td>
      <td class="table-actions" data-label="Actions">
        <a class="button small ghost" href="#/campaigns/${encodeURIComponent(campaign.id)}">${editable ? "Edit" : "Open"}</a>
        ${can("campaigns.send") ? `<button type="button" class="button small ghost" data-test="${escapeHtml(campaign.id)}">Send test</button>` : ""}
        ${can("campaigns.send") && ["sending", "submission_unknown", "cancel_requested"].includes(campaign.status) ? `<button type="button" class="button small" data-pause="${escapeHtml(campaign.id)}">${isLive() ? "Cancel unsent" : "Pause"}</button>` : ""}
        ${launchable ? `<button type="button" class="button small primary" data-launch="${escapeHtml(campaign.id)}" data-paused="${campaign.status === "paused" ? "yes" : "no"}">${campaign.status === "paused" ? "Return to draft" : "Launch"}</button>` : ask}
      </td>
    </tr>`;
  }).join("");
  document.querySelector("#content").innerHTML = `
    <div class="section-lead"><div><h2 class="nums">${(data.campaigns || []).length.toLocaleString()} ${(data.campaigns || []).length === 1 ? "campaign" : "campaigns"}</h2><p>${can("campaigns.send") ? "Draft, test, then launch to the audience." : can("campaigns.manage") ? "You can draft campaigns. An administrator sends tests and launches them." : "Read-only campaign reporting."}</p></div></div>
    <div class="toolbar"><label>Status<select id="campaign-status">${optionsHtml([["", "All statuses"], ...statuses.map((value) => [value, statusLabel(value)])], status)}</select></label></div>
    <section class="panel">${rows.length ? `<div class="table-wrap"><table class="responsive"><thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th>Submitted</th><th>Created</th><th></th></tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty-state"><div><h2>No campaigns yet</h2><p>${(data.campaigns || []).length ? "Nothing matches this status." : "Use New campaign after you have a list."}</p></div></div>`}</section>`;
  document.querySelector("#campaign-status")?.addEventListener("change", (event) => {
    state.campaignStatus = event.target.value;
    paintCampaigns(data);
  });
  document.querySelectorAll("[data-test]").forEach((button) => button.addEventListener("click", () => openTestSend(button.dataset.test)));
  document.querySelectorAll("[data-pause]").forEach((button) => button.addEventListener("click", () => campaignPost("pause", button.dataset.pause)));
  document.querySelectorAll("[data-launch]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.paused === "yes") confirmResume(button.dataset.launch);
    else openLaunch(button.dataset.launch);
  }));
}

function modeEditor(mode, draft) {
  if (mode === "visual") {
    const data = { ...emptyVisual, ...(draft || {}) };
    return `<div class="stack" data-mode-editor="visual">
      <div class="form-grid"><label>Layout<select data-visual-field="template">${optionsHtml([["announcement", "Announcement"], ["newsletter", "Newsletter"], ["simple", "Simple"]], data.template)}</select></label><label>Accent<input data-visual-field="accent_color" type="color" value="${escapeHtml(data.accent_color)}" /></label></div>
      <label>Brand name<input data-visual-field="brand_name" maxlength="80" value="${escapeHtml(data.brand_name)}" placeholder="CTN" /></label>
      <label>Inbox preview<input data-visual-field="preheader" maxlength="160" value="${escapeHtml(data.preheader)}" placeholder="Short line after the subject" /></label>
      <label>Headline<input data-visual-field="headline" maxlength="180" value="${escapeHtml(data.headline)}" placeholder="Headline" /></label>
      <label>Body<textarea data-visual-field="body" rows="7" placeholder="Write the update. Leave sample copy out until you mean to send it.">${escapeHtml(data.body)}</textarea></label>
      <div class="form-grid"><label>Button label<input data-visual-field="cta_label" maxlength="80" value="${escapeHtml(data.cta_label)}" placeholder="Learn more" /></label><label>Button link<input data-visual-field="cta_url" type="url" value="${escapeHtml(data.cta_url)}" placeholder="https://" /></label></div>
      <label>Closing line<input data-visual-field="footer" maxlength="240" value="${escapeHtml(data.footer)}" placeholder="Why the recipient is receiving this" /></label>
    </div>`;
  }
  if (mode === "rich_text") {
    return `<div data-mode-editor="rich_text" class="stack">
      <div class="rich-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" data-rich="bold" aria-label="Bold"><strong>B</strong></button>
        <button type="button" data-rich="italic" aria-label="Italic"><em>I</em></button>
        <button type="button" data-rich="underline" aria-label="Underline"><span style="text-decoration:underline">U</span></button>
        <button type="button" data-rich="insertUnorderedList" aria-label="Bulleted list">List</button>
        <button type="button" id="insert-link">Link</button>
        <label class="sr-only" for="merge-field">Insert merge field</label>
        <select id="merge-field" aria-label="Insert merge field"><option value="">Merge field</option><option value="{{first_name}}">First name</option><option value="{{last_name}}">Last name</option><option value="{{email}}">Email</option><option value="{{unsubscribe_url}}">Opt-out link (optional)</option></select>
      </div>
      <div id="link-pop" class="stack" hidden><label>Link address<input id="link-url" type="url" placeholder="https://" /></label><button type="button" class="button small" id="apply-link">Insert link</button></div>
      <div id="rich-editor" class="rich-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Campaign body" data-placeholder="Write the campaign. Sample text is not inserted for you.">${draft?.rich_html || ""}</div>
    </div>`;
  }
  if (mode === "plain_text") {
    return `<div data-mode-editor="plain_text"><label>Message<textarea id="plain-editor" class="plain-editor" rows="14" placeholder="Share the update here.">${escapeHtml(draft?.plain_text || "")}</textarea></label></div>`;
  }
  return `<div data-mode-editor="custom_html" class="stack"><label>HTML<textarea id="html-editor" class="code-area" rows="14" placeholder="Write the HTML body">${escapeHtml(draft?.html_body || "")}</textarea></label><label>Plain-text alternative<textarea id="html-text-fallback" rows="6" placeholder="Plain-text version of the message">${escapeHtml(draft?.text_body || "")}</textarea></label></div>`;
}

async function renderComposer(campaignId, token) {
  if (!campaignId && !can("campaigns.manage")) {
    document.querySelector("#content").innerHTML = `<section class="panel empty-state"><div><h2>Ask an administrator</h2><p>Your role can review campaigns. A marketer or administrator creates them.</p></div></section>`;
    return;
  }
  setChrome("campaigns", campaignId ? "Campaign" : "New campaign");
  document.querySelector("#content").innerHTML = `
    <div class="composer-page">
      <div class="section-lead"><div><h2>${campaignId ? "Campaign" : "New campaign"}</h2><p id="save-state" class="save-state">Loading…</p></div><a class="button ghost" href="#/campaigns">Back to campaigns</a></div>
      <div class="composer-layout">
        <form id="campaign-form" class="composer-fields stack">
          <label>Campaign name<input name="name" maxlength="160" placeholder="Internal name" /></label>
          <div id="audience-field"><label>To <span class="req">Required</span><select name="list_id" disabled><option>Loading lists…</option></select></label></div>
          <p id="audience-meta" class="help"></p>
          <label>Subject <span class="req">Required</span><input name="subject" maxlength="250" required placeholder="Subject line" /></label>
          <p id="from-line" class="help"></p>
          <div class="segmented" role="group" aria-label="Format">${contentModes.map((mode) => `<button type="button" data-mode="${mode.id}">${mode.title}</button>`).join("")}</div>
          <div id="mode-editor-host"></div>
          <div id="preflight" class="preflight"></div>
          <p class="form-error" data-form-error role="alert"></p>
          <div class="form-actions" id="composer-actions"></div>
        </form>
        <aside class="preview-pane stack">
          <div class="preview-toolbar" role="group" aria-label="Preview">
            <button type="button" data-preview-width="desktop" aria-pressed="true">Desktop</button>
            <button type="button" data-preview-width="mobile" aria-pressed="false">Mobile</button>
            <button type="button" data-preview-theme="light" aria-pressed="true">Light</button>
            <button type="button" data-preview-theme="dark" aria-pressed="false">Dark</button>
            <button type="button" id="preview-sample" aria-pressed="true">Sample contact</button>
          </div>
          <div id="preview-frame" class="preview-frame"><iframe title="Campaign preview" sandbox=""></iframe></div>
          <p class="help">The frame is the mail client. The message keeps the colours you write. Sample contact uses Alex Rivera.</p>
        </aside>
      </div>
    </div>`;
  const form = document.querySelector("#campaign-form");
  let lists = [];
  let campaign = {};
  try {
    const [listData, campaignData] = await Promise.all([
      getLists(),
      campaignId ? api(`/api/campaigns/${campaignId}`) : Promise.resolve(null),
    ]);
    lists = listData;
    campaign = campaignData?.campaign || {};
  } catch (error) {
    if (token !== state.renderToken) return;
    form.querySelector("[data-form-error]").textContent = error.message;
  }
  if (token !== state.renderToken || !form.isConnected) return;
  const stored = safeContentObject(campaign.content_json);
  let selectedMode = contentModes.some((mode) => mode.id === campaign.content_mode) ? campaign.content_mode : "rich_text";
  const drafts = {
    visual: selectedMode === "visual" ? { ...emptyVisual, ...stored } : { ...emptyVisual },
    rich_text: { schema_version: 1, rich_html: selectedMode === "rich_text" ? (stored.rich_html || "") : "" },
    custom_html: { schema_version: 1, html_body: campaign.html_body || "", text_body: campaign.text_body || "" },
    plain_text: { schema_version: 1, plain_text: selectedMode === "plain_text" ? (stored.plain_text || campaign.text_body || "") : "" },
  };
  let activeId = campaignId;
  let saveTimer = null;
  let savedAt = 0;
  const editable = can("campaigns.manage") && (!activeId || campaign.status === "draft" || (campaign.status === "paused" && can("campaigns.send")));
  form.elements.name.value = campaign.name || "";
  form.elements.subject.value = campaign.subject || "";
  const fromName = campaign.from_name || state.session?.user?.name || "CTN";
  const fromEmail = campaign.from_email || state.session?.enforced_from_email || "";
  document.querySelector("#from-line").textContent = fromEmail
    ? `From ${fromName} <${fromEmail}>${state.session?.reply_to_email ? ` · Reply-To ${state.session.reply_to_email}` : ""}`
    : "From address is not configured. An administrator sets it in Sending setup.";

  const paintAudience = () => {
    const host = document.querySelector("#audience-field");
    if (!lists.length) {
      host.innerHTML = `<div class="notice"><div><strong>No lists yet.</strong><p>Create a list and add contacts before this campaign can be saved.</p><a class="button" href="#/contacts">Go to contacts</a></div></div>`;
      return;
    }
    host.innerHTML = `<label>To <span class="req">Required</span><select name="list_id" required ${editable ? "" : "disabled"}>${listOptions(lists, campaign.list_id || lists[0].id)}</select></label>`;
    host.querySelector("select")?.addEventListener("change", () => { markDirty(); paintAudienceMeta(); });
    paintAudienceMeta();
  };
  const paintAudienceMeta = () => {
    const select = form.querySelector('[name="list_id"]');
    const list = lists.find((item) => item.id === select?.value);
    const eligible = Number(campaign.eligible_recipients ?? NaN);
    const meta = document.querySelector("#audience-meta");
    if (!list) { meta.textContent = ""; return; }
    const eligibleText = Number.isFinite(eligible) && activeId ? ` ${eligible.toLocaleString()} eligible to send right now.` : " Suppressed addresses are excluded when you launch.";
    meta.textContent = `${Number(list.contact_count || 0).toLocaleString()} contacts on ${list.name}.${eligibleText}`;
  };
  const capture = () => {
    if (selectedMode === "visual") {
      const visual = { schema_version: 1 };
      form.querySelectorAll("[data-visual-field]").forEach((field) => { visual[field.dataset.visualField] = field.value; });
      drafts.visual = visual;
    } else if (selectedMode === "rich_text") drafts.rich_text = { schema_version: 1, rich_html: sanitizeRichHtml(form.querySelector("#rich-editor")?.innerHTML || "") };
    else if (selectedMode === "plain_text") drafts.plain_text = { schema_version: 1, plain_text: form.querySelector("#plain-editor")?.value || "" };
    else drafts.custom_html = { schema_version: 1, html_body: form.querySelector("#html-editor")?.value || "", text_body: form.querySelector("#html-text-fallback")?.value || "" };
  };
  const currentContent = () => { capture(); return buildCampaignContent(selectedMode, drafts[selectedMode]); };
  const paintEditor = () => {
    document.querySelector("#mode-editor-host").innerHTML = modeEditor(selectedMode, drafts[selectedMode]);
    document.querySelectorAll("[data-mode]").forEach((button) => button.setAttribute("aria-pressed", button.dataset.mode === selectedMode ? "true" : "false"));
    const editor = form.querySelector("#rich-editor");
    editor?.addEventListener("paste", (event) => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    });
    form.querySelectorAll("[data-rich]").forEach((button) => button.addEventListener("click", () => {
      editor?.focus();
      document.execCommand(button.dataset.rich, false);
      markDirty();
    }));
    document.querySelector("#insert-link")?.addEventListener("click", () => { document.querySelector("#link-pop").hidden = false; });
    document.querySelector("#apply-link")?.addEventListener("click", () => {
      const url = safeComposerUrl(document.querySelector("#link-url").value);
      if (!url) return;
      editor?.focus();
      document.execCommand("createLink", false, url);
      document.querySelector("#link-pop").hidden = true;
      markDirty();
    });
    document.querySelector("#merge-field")?.addEventListener("change", (event) => {
      if (!event.target.value) return;
      insertAtCursor(editor || form.querySelector("textarea"), event.target.value);
      event.target.value = "";
      markDirty();
    });
    form.querySelectorAll("input, textarea, select").forEach((field) => field.addEventListener("input", markDirty));
    editor?.addEventListener("input", markDirty);
    refreshPreview();
  };
  const insertAtCursor = (field, text) => {
    if (!field) return;
    if (field.isContentEditable) {
      field.focus();
      document.execCommand("insertText", false, text);
      return;
    }
    const start = field.selectionStart ?? field.value.length;
    field.setRangeText(text, start, field.selectionEnd ?? start, "end");
  };
  const refreshPreview = () => {
    const content = currentContent();
    const sample = document.querySelector("#preview-sample")?.getAttribute("aria-pressed") === "true";
    let html = content.html_body;
    if (sample) {
      html = html.replaceAll("{{first_name}}", "Alex").replaceAll("{{last_name}}", "Rivera").replaceAll("{{email}}", "alex@example.com").replaceAll("{{unsubscribe_url}}", "#unsubscribe");
    }
    const frame = document.querySelector("#preview-frame iframe");
    if (frame) frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:;">${html}`;
    paintPreflight(content);
  };
  const paintPreflight = (content) => {
    const subject = form.elements.subject.value.trim();
    const checks = [];
    checks.push([Boolean(subject), subject ? "Subject is set" : "Add a subject"]);
    checks.push([!/^(re|fw|fwd)\s*:/i.test(subject), "Subject is not a reply or forward"]);
    checks.push([Boolean(form.querySelector('[name="list_id"]')?.value), "Audience is selected"]);
    checks.push([Boolean(content.text_body?.trim()), content.text_body?.trim() ? "Plain-text part is present" : "Add a plain-text part"]);
    const blob = `${subject}\n${content.html_body}\n${content.text_body}`;
    const placeholder = PLACEHOLDER_PATTERNS.find(([pattern]) => pattern.test(blob));
    checks.push([!placeholder, placeholder ? `Replace ${placeholder[1]}` : "No placeholder copy detected"]);
    const unknown = [...blob.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((match) => match[1]).filter((field) => !["first_name", "last_name", "email", "unsubscribe_url"].includes(field));
    checks.push([unknown.length === 0, unknown.length ? `Unknown merge field: ${unknown[0]}` : "Merge fields are recognised"]);
    document.querySelector("#preflight").innerHTML = `<strong>Before you send</strong><ul class="checklist">${checks.map(([ok, label]) => `<li><span class="${ok ? "done" : ""}">${ok ? "Pass" : "Check"} · ${escapeHtml(label)}</span></li>`).join("")}</ul>`;
  };
  const markDirty = () => {
    if (!editable) return;
    state.composerDirty = true;
    document.querySelector("#save-state").textContent = "Unsaved changes";
    refreshPreview();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveComposer(true), 1500);
  };
  const setSaved = () => {
    savedAt = Date.now();
    state.composerDirty = false;
    document.querySelector("#save-state").textContent = "Saved · just now";
  };
  const saveComposer = async (auto) => {
    if (!editable) return false;
    capture();
    const content = buildCampaignContent(selectedMode, drafts[selectedMode]);
    const subject = form.elements.subject.value.trim();
    const listId = form.querySelector('[name="list_id"]')?.value || "";
    if (!subject || !listId || !fromName || !fromEmail) {
      if (!auto) form.querySelector("[data-form-error]").textContent = "Name, subject, sender, and list are required.";
      return false;
    }
    const payload = {
      name: (form.elements.name.value.trim() || subject).slice(0, 160),
      subject,
      list_id: listId,
      from_name: fromName,
      from_email: fromEmail,
      content_mode: selectedMode,
      content_json: content.content_json,
      html_body: content.html_body,
      text_body: content.text_body,
    };
    try {
      const creating = !activeId;
      const result = await api(creating ? "/api/campaigns" : `/api/campaigns/${activeId}`, { method: creating ? "POST" : "PATCH", body: payload });
      if (creating && result?.campaign?.id) {
        activeId = result.campaign.id;
        history.replaceState(null, "", `#/campaigns/${activeId}`);
        state.route = readRoute();
        state.pageKey = pageKey(state.route);
      }
      invalidate("campaigns");
      setSaved();
      if (!auto) toast(creating ? "Draft saved" : "Campaign updated");
      form.querySelector("[data-form-error]").textContent = "";
      paintActions();
      return true;
    } catch (error) {
      form.querySelector("[data-form-error]").textContent = error.message;
      return false;
    }
  };
  const paintActions = () => {
    const actions = document.querySelector("#composer-actions");
    const launch = can("campaigns.send") && activeId && ["draft", "paused"].includes(campaign.status || "draft")
      ? `<button type="button" class="button primary" id="composer-launch">${campaign.status === "paused" ? "Return to draft" : "Launch"}</button>`
      : "";
    const ask = can("campaigns.manage") && !can("campaigns.send")
      ? `<p class="help">Ask an administrator to send a test or launch this campaign. You can keep editing the draft.</p>`
      : "";
    actions.innerHTML = `${ask}${editable ? `<button type="button" class="button" id="use-starter">Insert starter</button><button class="button primary" type="submit">Save draft</button>` : ""}${can("campaigns.send") && activeId ? `<button type="button" class="button" id="composer-test">Send test</button>` : ""}${launch}`;
    document.querySelector("#use-starter")?.addEventListener("click", () => {
      if (selectedMode === "rich_text") drafts.rich_text.rich_html = starterRich;
      if (selectedMode === "plain_text") drafts.plain_text.plain_text = starterPlain;
      if (selectedMode === "custom_html") { drafts.custom_html.html_body = starterHtml; drafts.custom_html.text_body = starterPlain; }
      if (selectedMode === "visual") drafts.visual = { ...emptyVisual, headline: "An update from CTN", body: "Share the update here.", cta_label: "Learn more", cta_url: "https://ctn-sk.com", footer: "You are receiving this because you opted in." };
      paintEditor();
      markDirty();
    });
    document.querySelector("#composer-test")?.addEventListener("click", () => openTestSend(activeId));
    document.querySelector("#composer-launch")?.addEventListener("click", () => {
      if (campaign.status === "paused") confirmResume(activeId);
      else openLaunch(activeId);
    });
  };
  paintAudience();
  paintEditor();
  form.elements.name?.addEventListener("input", markDirty);
  form.elements.subject?.addEventListener("input", markDirty);
  paintActions();
  document.querySelector("#save-state").textContent = activeId ? "Saved" : "Not saved yet";
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    if (!editable || button.dataset.mode === selectedMode) return;
    capture();
    selectedMode = button.dataset.mode;
    paintEditor();
    markDirty();
  }));
  document.querySelectorAll("[data-preview-width]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-preview-width]").forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
    document.querySelector("#preview-frame").classList.toggle("mobile", button.dataset.previewWidth === "mobile");
  }));
  document.querySelectorAll("[data-preview-theme]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-preview-theme]").forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
    document.querySelector("#preview-frame").classList.toggle("dark", button.dataset.previewTheme === "dark");
  }));
  document.querySelector("#preview-sample")?.addEventListener("click", (event) => {
    const pressed = event.currentTarget.getAttribute("aria-pressed") !== "true";
    event.currentTarget.setAttribute("aria-pressed", pressed ? "true" : "false");
    refreshPreview();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearTimeout(saveTimer);
    await saveComposer(false);
  });
  state.composerClock = setInterval(() => {
    const label = document.querySelector("#save-state");
    if (!savedAt || state.composerDirty || !label) return;
    const seconds = Math.max(1, Math.round((Date.now() - savedAt) / 1000));
    label.textContent = seconds < 60 ? `Saved · ${seconds}s ago` : `Saved · ${relativeTime(savedAt)}`;
  }, 5000);
  if (!editable) form.querySelectorAll("input, textarea, select, [contenteditable]").forEach((field) => { field.setAttribute("disabled", "true"); field.setAttribute("contenteditable", "false"); });
}

function openTestSend(campaignId) {
  if (!can("campaigns.send")) return;
  const live = isLive();
  openModal("Send a test", "Campaign", "md", `<p class="help">Loading campaign…</p>`);
  api(`/api/campaigns/${campaignId}`).then(({ campaign }) => {
    openModal("Send a test", "Campaign", "md", `
      <form id="test-send-form" class="stack">
        <div class="${live ? "notice warning" : "notice"}"><div><strong>${live ? "This sends a real test through your sending service." : "Preview captures the campaign in Deliveries. Nothing is mailed out."}</strong></div></div>
        <p>${escapeHtml(campaign.name)} · ${escapeHtml(campaign.subject || "")}</p>
        <label>Test recipient <span class="req">Required</span><input name="email" type="email" required value="${escapeHtml(state.session?.user?.email || "")}" autocomplete="email" /><span class="help">${live ? "The address must be on the test allowlist. It counts toward today’s limit." : "It counts toward today’s limit. Special-use domains are rejected."}</span></label>
        ${live ? `<label class="check"><input type="checkbox" name="ack_live" required /><span>I understand this sends a real email.</span></label>` : ""}
        <p class="form-error" role="alert"></p>
        <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button ${live ? "danger" : "primary"}" type="submit">${live ? "Send test" : "Capture test"}</button></div>
      </form>`);
    document.querySelector("#test-send-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const email = form.elements.email.value.trim();
      const result = await submitForm(form, () => api(`/api/campaigns/${campaignId}/test-send`, { method: "POST", body: { email } }), live ? `Test sent to ${email}` : `Test captured for ${email}`);
      if (!result) return;
      closeModal();
      go("deliveries", "", new URLSearchParams({ campaign_id: campaignId }));
    });
  }).catch((error) => toast(error.message, "error"));
}

function openLaunch(campaignId) {
  openModal("Launch campaign", "Confirm", "md", `<p class="help">Loading audience…</p>`);
  api(`/api/campaigns/${campaignId}`).then(({ campaign }) => {
    const live = isLive();
    const eligible = Number(campaign.eligible_recipients || 0);
    const list = state.lists.find((item) => item.id === campaign.list_id);
    const daily = Number(state.summary?.daily_limit || state.session?.daily_limit || 0);
    const sent = Number(state.summary?.counts?.sent_today ?? state.session?.sent_today ?? 0);
    const remaining = Math.max(0, daily - sent);
    const covered = Math.min(eligible, remaining);
    const minutes = Math.ceil((covered / PROVIDER_HOURLY_CAP) * 60);
    openModal(live ? "Send this campaign?" : "Capture this campaign?", "Confirm", "md", `
      <div class="stack" id="launch-confirm">
        <div class="${live ? "notice warning" : "notice"}"><div><strong>${live ? "Eligible recipients will receive a real email." : "Preview stores each delivery in this workspace. Nothing is mailed out."}</strong></div></div>
        ${eligible === 0 ? `<div class="notice warning"><div>No eligible recipients on this list. The launch will finish with nothing sent.</div></div>` : ""}
        <dl class="message-meta">
          <dt>Campaign</dt><dd>${escapeHtml(campaign.name)}</dd>
          <dt>To</dt><dd>${escapeHtml(campaign.list_name || "")}${list ? ` · ${Number(list.contact_count || 0).toLocaleString()} on the list` : ""}</dd>
          <dt>Eligible</dt><dd class="nums">${eligible.toLocaleString()} active contacts, suppressions excluded</dd>
          <dt>From</dt><dd>${escapeHtml(campaign.from_name || "")} &lt;${escapeHtml(campaign.from_email || "")}&gt;</dd>
          <dt>Reply-To</dt><dd>${escapeHtml(state.session?.reply_to_email || "Not set")}</dd>
          <dt>Time</dt><dd>${eligible === 0 ? "Nothing to send" : `About ${minutes.toLocaleString()} min at ${PROVIDER_HOURLY_CAP}/hour, if today’s remaining ${remaining.toLocaleString()} covers this send.`}</dd>
        </dl>
        ${live ? `<label class="check"><input id="launch-ack" type="checkbox" /><span>I understand this emails real recipients.</span></label><label>Type SEND to confirm<input id="launch-type" autocomplete="off" /></label>` : ""}
        <p id="launch-error" class="form-error" role="alert"></p>
        <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button type="button" class="button ${live ? "danger" : "primary"}" id="confirm-launch" ${live ? "disabled" : ""}>${live ? "Send campaign" : "Capture campaign"}</button></div>
      </div>`);
    const confirm = document.querySelector("#confirm-launch");
    const sync = () => {
      if (!live) return;
      confirm.disabled = !(document.querySelector("#launch-ack").checked && document.querySelector("#launch-type").value.trim() === "SEND");
    };
    document.querySelector("#launch-ack")?.addEventListener("change", sync);
    document.querySelector("#launch-type")?.addEventListener("input", sync);
    confirm.addEventListener("click", async () => {
      setBusy(confirm, true);
      try {
        const result = await api(`/api/campaigns/${campaignId}/launch`, { method: "POST", body: {} });
        closeModal();
        invalidate("campaigns");
        toast(launchOutcome(result));
        go("campaigns", "", null, true);
      } catch (error) {
        document.querySelector("#launch-error").textContent = error.message;
        setBusy(confirm, false);
        sync();
      }
    });
  }).catch((error) => toast(error.message, "error"));
}

function launchOutcome(result) {
  const queued = Number(result?.queued ?? 0);
  const sent = Number(result?.sent ?? queued);
  const failed = Number(result?.failed ?? 0);
  if (isLive()) return failed ? `Sending: ${queued} queued · ${failed} failed` : `Sending to ${queued} recipient${queued === 1 ? "" : "s"}`;
  if (failed) return `Preview finished: ${sent} captured · ${failed} failed`;
  if (!sent) return "Preview finished. No eligible recipients.";
  return `Preview captured ${sent} ${sent === 1 ? "delivery" : "deliveries"}`;
}

function confirmResume(id) {
  openModal("Return to draft?", "Campaign", "sm", `
    <div class="stack"><p>This puts the campaign back in draft so it can be edited. It does not continue a send that already started.</p>
    <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button type="button" class="button primary" id="confirm-resume">Return to draft</button></div></div>`);
  document.querySelector("#confirm-resume").addEventListener("click", async () => {
    closeModal();
    await campaignPost("resume", id);
  });
}

async function campaignPost(action, id) {
  try {
    const result = await api(`/api/campaigns/${id}/${action}`, { method: "POST", body: {} });
    invalidate("campaigns");
    if (action === "launch") toast(launchOutcome(result));
    else if (action === "pause") toast(isLive() ? "Unsent recipients cancelled" : "Delivery paused");
    else if (action === "resume") toast("Campaign returned to draft");
    go("campaigns", "", null, true);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renderDeliveries(token) {
  const params = state.route.params;
  const key = `deliveries:${params.toString()}`;
  if (cache.get(key)) paintDeliveries(cache.get(key), params);
  else setLoading();
  setRefreshing(Boolean(cache.get(key)));
  const data = await api(`/api/messages${params.toString() ? `?${params}` : ""}`);
  if (token !== state.renderToken) return;
  cache.set(key, data);
  paintDeliveries(data, params);
  setRefreshing(false);
}

function paintDeliveries(data, params) {
  const messages = data.messages || [];
  const filtering = ["q", "status", "from", "to", "campaign_id"].some((key) => params.get(key));
  const rows = messages.map((message) => `<tr>
    <td data-label="Recipient" class="email">${escapeHtml(message.to_email)}</td>
    <td data-label="Campaign">${escapeHtml(message.campaign_name || "Test")}<span class="subtext">${escapeHtml(message.subject || "")}</span></td>
    <td data-label="Status">${statusPill(message.status)}</td>
    <td data-label="Submitted">${timeHtml(message.created_at)}</td>
    <td class="table-actions" data-label=""><a class="button small ghost" href="#/deliveries/${encodeURIComponent(message.id)}">View</a></td>
  </tr>`).join("");
  const filters = filtering || messages.length ? `<div class="toolbar">
      ${searchField("delivery-search", "Search deliveries", params.get("q") || "", "Recipient, subject, or campaign")}
      <label>Status<select id="delivery-status">${optionsHtml([["", "All statuses"], ...FILTER_STATUSES.map((value) => [value, statusLabel(value)])], params.get("status") || "")}</select></label>
      <div class="date-range"><label>From<input id="delivery-from" type="date" value="${escapeHtml(params.get("from") || "")}" /></label><label>To<input id="delivery-to" type="date" value="${escapeHtml(params.get("to") || "")}" /></label></div>
    </div>` : "";
  document.querySelector("#content").innerHTML = `
    <div class="section-lead"><div><h2 class="nums">${messages.length.toLocaleString()} ${messages.length === 1 ? "delivery" : "deliveries"}</h2><p>Submitted means Spacemail accepted the message over SMTP. It is not proof of inbox placement.</p></div>${filtering ? `<a class="button" href="#/deliveries">Clear filters</a>` : ""}</div>
    ${messages.length || filtering ? deliveryLegend() : ""}
    ${filters}
    <section class="panel">${messages.length ? `<div class="table-wrap"><table class="responsive"><thead><tr><th>Recipient</th><th>Campaign</th><th>Status</th><th>Submitted</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><div><h2>${filtering ? "No matching deliveries" : "No deliveries yet"}</h2><p>${filtering ? "Clear a filter to see more." : "A test or a launch will record each recipient here."}</p></div></div>`}</section>`;
  bindFilterInput("delivery-search", "q", "deliveries");
  document.querySelector("#delivery-status")?.addEventListener("change", (event) => setParam("deliveries", "status", event.target.value));
  document.querySelector("#delivery-from")?.addEventListener("change", (event) => setParam("deliveries", "from", event.target.value));
  document.querySelector("#delivery-to")?.addEventListener("change", (event) => setParam("deliveries", "to", event.target.value));
}

async function renderMailbox(token) {
  setChrome("mailbox");
  const params = state.route.params;
  const folder = params.get("folder") === "sent" ? "sent" : "inbox";
  document.querySelector("#content").innerHTML = `<div class="section-lead"><div><h2>Mailbox</h2><p>Reading the Spacemail mailbox over IMAP. Deliveries is the local send log.</p></div></div><section class="panel"><p class="help">Loading ${folder}…</p></section>`;
  let data;
  try {
    data = await api(`/api/mailbox?folder=${encodeURIComponent(folder)}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    document.querySelector("#content").innerHTML = `
      <div class="section-lead"><div><h2>Mailbox</h2><p>Inbox and Sent from the Spacemail mailbox.</p></div></div>
      <div class="notice warning"><div><strong>Mailbox unavailable.</strong><p>${escapeHtml(error.message)}</p></div></div>`;
    return;
  }
  if (token !== state.renderToken) return;
  const messages = data.messages || [];
  const tabs = `
    <div class="rail" role="tablist" aria-label="Mailbox folders">
      <a href="#/mailbox?folder=inbox" ${folder === "inbox" ? 'aria-current="true"' : ""}>Inbox</a>
      <a href="#/mailbox?folder=sent" ${folder === "sent" ? 'aria-current="true"' : ""}>Sent</a>
    </div>`;
  const rows = messages.map((message) => `
    <tr>
      <td data-label="From">${escapeHtml(message.from || "—")}</td>
      <td data-label="To">${escapeHtml(message.to || "—")}</td>
      <td data-label="Subject"><a href="#/mailbox/${encodeURIComponent(message.uid)}?folder=${encodeURIComponent(folder)}">${escapeHtml(message.subject || "(no subject)")}</a></td>
      <td data-label="When">${timeHtml(message.date, { relative: true })}</td>
    </tr>`).join("");
  document.querySelector("#content").innerHTML = `
    <div class="section-lead"><div><h2>${folder === "sent" ? "Sent" : "Inbox"}</h2><p>Latest ${messages.length} messages from Spacemail.</p></div></div>
    ${tabs}
    <section class="panel">${messages.length
      ? `<div class="table-wrap"><table class="responsive"><thead><tr><th>From</th><th>To</th><th>Subject</th><th>When</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty-state"><div><h2>No messages in ${folder}</h2><p>Messages appear here after Spacemail stores them in this folder.</p></div></div>`}</section>`;
}

async function openMailboxMessage(uid) {
  const folder = state.route.params.get("folder") === "sent" ? "sent" : "inbox";
  openDrawer("Message", folder === "sent" ? "Sent" : "Inbox", `<p class="help">Loading message…</p>`);
  try {
    const { message } = await api(`/api/mailbox/message?folder=${encodeURIComponent(folder)}&uid=${encodeURIComponent(uid)}`);
    const body = message.html
      ? `<iframe class="email-preview" title="Message body" sandbox="" srcdoc="${escapeHtml(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:;">${message.html}`)}"></iframe>`
      : `<pre class="code-area" style="white-space:pre-wrap">${escapeHtml(message.text || "")}</pre>`;
    openDrawer(message.subject || "Message", folder === "sent" ? "Sent" : "Inbox", `
      <dl class="message-meta">
        <dt>From</dt><dd>${escapeHtml(message.from || "—")}</dd>
        <dt>To</dt><dd>${escapeHtml(message.to || "—")}</dd>
        <dt>When</dt><dd>${timeHtml(message.date)}</dd>
      </dl>
      <div class="stack">${body}</div>
      <div class="form-actions"><a class="button" href="#/mailbox?folder=${encodeURIComponent(folder)}">Back to ${folder}</a></div>`);
  } catch (error) {
    openDrawer("Message", "Error", `<div class="notice warning"><div>${escapeHtml(error.message)}</div></div>`);
  }
}

function setParam(section, key, value) {
  const params = new URLSearchParams(state.route.params);
  if (value) params.set(key, value); else params.delete(key);
  go(section, "", params);
}

function bindFilterInput(id, key, section) {
  const input = document.querySelector(`#${id}`);
  let timer;
  input?.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => setParam(section, key, input.value.trim()), 280);
  });
  if (input?.value) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

async function openDelivery(messageId) {
  openDrawer("Delivery", "Outcome", `<p class="help">Loading delivery…</p>`);
  try {
    const { message } = await api(`/api/messages/${messageId}`);
    const events = [
      ["Recorded", message.created_at],
      message.error ? ["Error", message.error] : null,
    ].filter(Boolean);
    openDrawer(message.subject || "Delivery", "Outcome", `
      <dl class="message-meta">
        <dt>Recipient</dt><dd class="email">${escapeHtml(message.to_email)}</dd>
        <dt>Campaign</dt><dd>${escapeHtml(message.campaign_name || "Test")}</dd>
        <dt>From</dt><dd>${escapeHtml(message.from_email || "")}</dd>
        <dt>Status</dt><dd>${statusPill(message.status)}<span class="help">${escapeHtml(statusMeaning(message.status))}</span></dd>
      </dl>
      <h3>Timeline</h3>
      <ul class="timeline">${events.map(([label, value]) => `<li><span class="marker"></span><div><strong>${escapeHtml(label)}</strong><p class="help">${typeof value === "string" && value.includes("T") ? timeHtml(value) : escapeHtml(value)}</p></div></li>`).join("")}</ul>
      <div class="message-preview"><iframe title="Rendered delivery" sandbox=""></iframe></div>
      ${message.unsubscribe_token ? `<div class="form-actions"><a class="button" href="/u/${encodeURIComponent(message.unsubscribe_token)}" target="_blank" rel="noopener">Open unsubscribe</a></div>` : ""}`);
    const frame = document.querySelector(".drawer-body iframe");
    if (frame) frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" >${message.html_body || ""}`;
  } catch (error) {
    openDrawer("Delivery", "Outcome", `<p class="form-error">${escapeHtml(error.message)}</p>`);
  }
}

async function renderSuppressions(token) {
  if (cache.get("suppressions")) paintSuppressions(cache.get("suppressions").suppressions || []);
  else setLoading();
  const data = await api("/api/suppressions");
  if (token !== state.renderToken) return;
  cache.set("suppressions", data);
  paintSuppressions(data.suppressions || []);
  setRefreshing(false);
}

function paintSuppressions(entries) {
  const params = state.route.params;
  const q = (params.get("q") || "").toLowerCase();
  const reason = params.get("reason") || "";
  const rows = entries.filter((entry) => (!q || String(entry.email).toLowerCase().includes(q)) && (!reason || entry.reason === reason));
  const reasons = [...new Set(entries.map((entry) => entry.reason).filter(Boolean))];
  document.querySelector("#content").innerHTML = `
    <div class="section-lead"><div><h2 class="nums">${entries.length.toLocaleString()} suppressed</h2><p>These addresses are excluded from every campaign.</p></div>${can("suppressions.manage") ? `<button type="button" class="button danger" id="add-suppression">Suppress addresses</button>` : ""}</div>
    <div class="toolbar">
      ${searchField("suppression-search", "Search suppressions", params.get("q") || "", "Search addresses")}
      <label>Reason<select id="suppression-reason">${optionsHtml([["", "All reasons"], ...reasons.map((value) => [value, statusLabel(value)])], reason)}</select></label>
    </div>
    <section class="panel">${rows.length ? `<div class="table-wrap"><table class="responsive"><thead><tr><th>Address</th><th>Reason</th><th>Source</th><th>Added</th><th></th></tr></thead><tbody>${rows.map((entry) => `<tr>
      <td data-label="Address" class="email">${escapeHtml(entry.email)}</td>
      <td data-label="Reason">${statusPill(entry.reason)}</td>
      <td data-label="Source">${escapeHtml(titleCase(entry.source || ""))}</td>
      <td data-label="Added">${timeHtml(entry.created_at)}</td>
      <td class="table-actions" data-label="">${entry.reason === "manual" && can("suppressions.manage") ? `<button type="button" class="button small danger" data-remove-suppression="${escapeHtml(entry.email)}">Remove</button>` : `<span class="help">Kept</span>`}</td>
    </tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><div><h2>No suppressions</h2><p>Unsubscribes, bounces, complaints, and manual exclusions appear here.</p></div></div>`}</section>`;
  bindFilterInput("suppression-search", "q", "suppressions");
  document.querySelector("#suppression-reason")?.addEventListener("change", (event) => setParam("suppressions", "reason", event.target.value));
  document.querySelector("#add-suppression")?.addEventListener("click", openSuppressionModal);
  document.querySelectorAll("[data-remove-suppression]").forEach((button) => button.addEventListener("click", () => openRemoveSuppression(button.dataset.removeSuppression)));
}

function openSuppressionModal() {
  openModal("Suppress addresses", "Safety", "md", `
    <form id="suppression-form" class="stack">
      <div class="notice warning"><div>This is a global manual exclusion. Unsubscribes come from the recipient link. Existing bounce and complaint rows stay protected.</div></div>
      <label>Email addresses <span class="req">Required</span><textarea name="emails" rows="5" required placeholder="one@example.com, two@example.com"></textarea><span class="help">Separate addresses with commas, spaces, or new lines.</span></label>
      <p class="help">A written reason is not stored yet. These records are saved as manual exclusions.</p>
      <p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button danger" type="submit">Suppress globally</button></div>
    </form>`);
  document.querySelector("#suppression-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const emails = [...new Set(form.emails.value.split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter(Boolean))];
    const invalid = emails.filter((email) => !validEmail(email));
    if (!emails.length || invalid.length) {
      form.querySelector(".form-error").textContent = invalid.length ? `Check ${invalid[0]}` : "Enter at least one email address.";
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    setBusy(submit, true);
    const failed = [];
    for (const email of emails) {
      try { await api("/api/suppressions", { method: "POST", body: { email, reason: "manual" } }); }
      catch (error) { failed.push(`${email}: ${error.message}`); }
    }
    setBusy(submit, false);
    if (failed.length === emails.length) {
      form.querySelector(".form-error").textContent = failed[0];
      return;
    }
    invalidate("suppressions");
    closeModal();
    toast(failed.length ? `Suppressed ${emails.length - failed.length}. ${failed.length} failed.` : `Suppressed ${emails.length} ${emails.length === 1 ? "address" : "addresses"}`);
    go("suppressions", "", null, true);
  });
}

function openRemoveSuppression(email) {
  openModal("Remove suppression", "Safety", "md", `
    <form id="remove-suppression-form" class="stack">
      <div class="notice warning"><div><strong>${escapeHtml(email)}</strong> will become active again and can be included in campaigns. Bounce, complaint, and unsubscribe records cannot be cleared here.</div></div>
      <p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button danger" type="submit">Remove suppression</button></div>
    </form>`);
  document.querySelector("#remove-suppression-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await submitForm(form, () => api(`/api/suppressions/${encodeURIComponent(email)}`, { method: "DELETE", body: {} }), "Suppression removed");
    if (!result) return;
    invalidate("suppressions");
    closeModal();
    go("suppressions", "", null, true);
  });
}

async function renderSending(token) {
  setLoading();
  const [data, summary] = await Promise.all([
    api("/api/production-readiness"),
    api("/api/summary").catch(() => state.summary),
  ]);
  if (token !== state.renderToken) return;
  if (summary) { state.summary = summary; updateStatus(summary); }
  const checks = data.checks || [];
  const ready = checks.filter((check) => check.status === "ready").length;
  const titles = {
    vercel_runtime: "Application host",
    postgres_database: "Database",
    launch_job_cron: "Scheduled sending",
    sender_identity: "Sender address",
    spacemail_smtp: "Sending service",
    delivery_health: "Delivery health",
  };
  const hint = (check) => {
    if (check.status === "ready") return "Passing";
    if (check.id === "launch_job_cron") return "Scheduled sending is not configured.";
    if (check.id === "spacemail_smtp") return "The sending service is not ready for live email.";
    if (check.id === "sender_identity") return "Sender address still needs setup.";
    return "Needs attention.";
  };
  const health = data.delivery_health || {};
  const limit = Number(summary?.daily_limit || state.session?.daily_limit || 0);
  const sent = Number(summary?.counts?.sent_today || 0);
  const width = limit ? Math.min(100, Math.round((sent / limit) * 100)) : 0;
  const liveReady = Boolean(data.ready_for_live_sending);
  document.querySelector("#content").innerHTML = `
    <section class="panel" style="margin-bottom:16px"><div class="panel-body">
      <span class="status ${liveReady ? "completed" : "paused"}">${liveReady ? "Ready to send" : "Not ready to send"}</span>
      <h2 style="margin-top:8px">${ready} of ${checks.length} checks passing</h2>
      <p class="help">From ${escapeHtml(data.current?.from_email || "not set")} · Reply-To ${escapeHtml(data.current?.reply_to_email || "not set")}</p>
    </div></section>
    <section class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h2>Readiness</h2></div>
      <div class="panel-body readiness-list">${checks.map((check) => `<div class="readiness-item"><span class="marker ${check.status === "ready" ? "ready" : ""}">${check.status === "ready" ? "✓" : ""}</span><div><strong>${escapeHtml(titles[check.id] || check.label)}</strong><p class="help">${escapeHtml(hint(check))}</p></div><span class="status ${check.status === "ready" ? "completed" : "paused"}">${escapeHtml(readinessLabel(check.status))}</span></div>`).join("")}</div>
    </section>
    <section class="panel" style="margin-bottom:16px">
      <div class="panel-head"><div><h2>Delivery health</h2><p>Last 7 days, without recipient addresses</p></div><span class="status ${health.healthy ? "completed" : "paused"}">${health.healthy ? "Healthy" : "Needs attention"}</span></div>
      <div class="panel-body"><div class="stat-grid">
        ${["submitted", "failed", "suppressed", "unsubscribed"].map((key) => `<article class="stat-card"><span class="stat-label">${statusLabel(key)}</span><strong class="stat-value nums">${Number(health[key] || 0).toLocaleString()}</strong></article>`).join("")}
      </div>${(health.issues || []).length ? `<div class="notice warning" style="margin-top:12px"><div>${health.issues.map((issue) => `<p>${escapeHtml(issue)}</p>`).join("")}</div></div>` : `<p class="help" style="margin-top:12px">Spacemail records acceptance at SMTP submit. Inbox delivery, bounces, and complaints are not reported back.</p>`}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Today’s volume</h2></div>
      <div class="panel-body stack">
        <p>This workspace can send <strong class="nums">${limit.toLocaleString()}</strong> emails today. <strong class="nums">${sent.toLocaleString()}</strong> are used, so <strong class="nums">${Math.max(0, limit - sent).toLocaleString()}</strong> remain. The sending service accepts about ${PROVIDER_HOURLY_CAP.toLocaleString()} an hour.</p>
        <div class="meter" aria-hidden="true"><span style="width:${width}%"></span></div>
        <p class="help">${escapeHtml(data.volume_plan?.launch_policy || "")}</p>
      </div>
    </section>
    <details class="panel tech-details"><summary class="panel-head">Technical details</summary><div class="panel-body stack">
      <p class="help">These names come from the setup endpoint. They are hidden from the everyday view.</p>
      ${(data.checks || []).map((check) => `<p><strong>${escapeHtml(check.label)}</strong><br><span class="help">${escapeHtml(check.detail || "")}</span></p>`).join("")}
      <ol>${(data.delivery_path || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
    </div></details>`;
}

function readinessLabel(status) {
  return {
    ready: "Ready", pending: "Pending", migration_required: "Setup required", not_connected: "Not connected",
    not_verified: "Not verified", configured_locked: "Configured, live off", configured: "Configured", unreachable: "Unreachable",
  }[status] || titleCase(status);
}

async function renderUsers(token) {
  setLoading();
  const data = await api("/api/users");
  if (token !== state.renderToken) return;
  state.users = data.users;
  state.roles = data.roles;
  state.permissionDefinitions = data.permissions;
  const byId = Object.fromEntries(data.permissions.map((permission) => [permission.id, permission]));
  const grouped = PERMISSION_GROUPS.map(([label, ids]) => ({ label, items: ids.map((id) => byId[id]).filter(Boolean) }));
  document.querySelector("#content").innerHTML = `
    <div class="section-lead"><div><h2 class="nums">${data.users.length.toLocaleString()} ${data.users.length === 1 ? "user" : "users"}</h2><p>Use a person’s name so the account menu does not repeat their role.</p></div><button type="button" class="button primary" id="create-user">Create user</button></div>
    <section class="panel"><div class="table-wrap"><table class="responsive"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Created</th><th></th></tr></thead><tbody>${data.users.map((user) => `<tr>
      <td data-label="User"><div class="table-user"><span class="avatar">${escapeHtml(initials(user.name))}</span><div><strong>${escapeHtml(user.name)}</strong>${user.is_current_user ? `<span class="status">You</span>` : ""}<span class="subtext email">${escapeHtml(user.email)}</span></div></div></td>
      <td data-label="Role">${escapeHtml(user.role_label || ROLE_LABELS[user.role] || titleCase(user.role))}</td>
      <td data-label="Status">${statusPill(user.active ? "active" : "disabled")}</td>
      <td data-label="Last sign-in">${user.last_login_at ? timeHtml(user.last_login_at, { relative: true }) : "Never"}</td>
      <td data-label="Created">${timeHtml(user.created_at)}</td>
      <td class="table-actions" data-label=""><a class="button small" href="#/users/${encodeURIComponent(user.id)}">Manage</a></td>
    </tr>`).join("")}</tbody></table></div></section>
    <section class="role-grid">${data.roles.map((role) => `<article class="role-card"><h3>${escapeHtml(role.label)}</h3><p>${escapeHtml(role.description)}</p><p class="help nums">${role.permissions.length} permissions</p></article>`).join("")}</section>
    <section class="panel"><div class="panel-head"><h2>Permissions</h2></div><div class="table-wrap"><table class="permission-table"><thead><tr><th>Capability</th>${data.roles.map((role) => `<th>${escapeHtml(role.label)}</th>`).join("")}</tr></thead><tbody>${grouped.map((group) => `<tr><th colspan="${data.roles.length + 1}">${escapeHtml(group.label)}</th></tr>${group.items.map((permission) => `<tr><td><strong>${escapeHtml(permission.label)}</strong><span class="subtext">${escapeHtml(permission.description)}</span></td>${data.roles.map((role) => `<td>${role.permissions.includes(permission.id) ? `<span class="status completed">Granted</span>` : `<span class="status">Not granted</span>`}</td>`).join("")}</tr>`).join("")}`).join("")}</tbody></table></div></section>`;
  document.querySelector("#create-user")?.addEventListener("click", openCreateUser);
}

function openCreateUser() {
  openModal("Create user", "Access", "md", `
    <form id="create-user-form" class="stack" autocomplete="off">
      <label>Full name <span class="req">Required</span><input name="name" maxlength="120" required /><span class="help">Use the person’s name, not their role.</span></label>
      <label>Email address <span class="req">Required</span><input name="email" type="email" required /></label>
      <label>Role<select name="role">${state.roles.map((role) => `<option value="${escapeHtml(role.id)}">${escapeHtml(role.label)}</option>`).join("")}</select></label>
      <label>Temporary password <span class="req">Required</span><input name="password" type="password" minlength="12" required autocomplete="new-password" /><span class="help">At least 12 characters. Share it in a secure channel.</span></label>
      <p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create user</button></div>
    </form>`);
  document.querySelector("#create-user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await submitForm(form, () => api("/api/users", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "User created");
    if (!result) return;
    closeModal();
    go("users", "", null, true);
  });
}

function openManageUser(userId) {
  const user = state.users.find((entry) => entry.id === userId);
  if (!user) return;
  const selfLocked = user.is_current_user;
  openDrawer(`Manage ${user.name}`, "Access", `
    <div class="stack">
      ${selfLocked ? `<div class="notice"><div>This is your account. Another administrator must change your role or disable access.</div></div>` : `<div class="notice warning"><div>Role or status changes sign this person out. Disabled accounts keep their audit history.</div></div>`}
      <form id="user-access-form" class="stack">
        <label>Full name <span class="req">Required</span><input name="name" required value="${escapeHtml(user.name)}" /><span class="help">A real name keeps the account menu clear.</span></label>
        <label>Email <span class="req">Required</span><input name="email" type="email" required value="${escapeHtml(user.email)}" /></label>
        <div class="form-grid"><label>Role<select name="role" ${selfLocked ? "disabled" : ""}>${state.roles.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === user.role ? "selected" : ""}>${escapeHtml(role.label)}</option>`).join("")}</select></label><label>Status<select name="active" ${selfLocked ? "disabled" : ""}><option value="true" ${user.active ? "selected" : ""}>Active</option><option value="false" ${!user.active ? "selected" : ""}>Disabled</option></select></label></div>
        <p class="form-error" role="alert"></p>
        <button class="button primary" type="submit">Save access</button>
      </form>
      <form id="reset-password-form" class="stack">
        <h3>Reset password</h3>
        <label>Temporary password <span class="req">Required</span><input name="password" type="password" minlength="12" required autocomplete="new-password" /></label>
        <p class="form-error" role="alert"></p>
        <button class="button" type="submit">Reset password</button>
      </form>
      <p class="help">Last sign-in ${user.last_login_at ? absoluteTime(user.last_login_at) : "has not happened"}. ${can("audit.view") ? `<a href="#/audit?q=${encodeURIComponent(user.email)}">Recent activity is in the audit log.</a>` : "Recent activity is in the audit log."}</p>
    </div>`);
  document.querySelector("#user-access-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await submitForm(form, () => api(`/api/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: {
        name: form.elements.name.value,
        email: form.elements.email.value,
        role: selfLocked ? user.role : form.elements.role.value,
        active: selfLocked ? user.active : form.elements.active.value === "true",
      },
    }), "User access updated");
    if (!result) return;
    go("users", "", null, true);
  });
  document.querySelector("#reset-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await submitForm(form, () => api(`/api/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST", body: { password: form.elements.password.value } }), "Password reset. Active sessions were signed out.");
    if (!result) return;
    if (user.is_current_user) showLogin();
    else go("users", "", null, true);
  });
}

async function renderAudit(token) {
  const params = state.route.params;
  const key = `audit:${params.toString()}`;
  if (cache.get(key)) paintAudit(cache.get(key).events || [], params);
  else setLoading();
  setRefreshing(Boolean(cache.get(key)));
  const data = await api(`/api/audit${params.toString() ? `?${params}` : ""}`);
  if (token !== state.renderToken) return;
  cache.set(key, data);
  paintAudit(data.events || [], params);
  setRefreshing(false);
}

function paintAudit(events, params) {
  const filtering = ["q", "action", "entity_type", "from", "to"].some((key) => params.get(key));
  let lastDay = "";
  const rows = events.map((event) => {
    const detail = formatAuditDetail(event.detail);
    const day = dayKey(event.created_at);
    const ip = formatIp(detail.ip);
    const head = day === lastDay ? "" : `<tr class="day-row"><th colspan="5">${escapeHtml(day)}</th></tr>`;
    lastDay = day;
    const ipHtml = !ip ? "" : ip === "Local / server" ? "Local / server" : `<span class="ip">${escapeHtml(ip)}</span>`;
    return `${head}<tr>
      <td data-label="When">${timeHtml(event.created_at, { relative: true })}</td>
      <td data-label="Actor">${escapeHtml(event.actor_name || "System")}</td>
      <td data-label="Action"><strong>${escapeHtml(auditActionLabel(event.action))}</strong></td>
      <td data-label="Record">${escapeHtml(titleCase(event.entity_type))}${event.entity_label ? `<span class="subtext">${escapeHtml(event.entity_label)}</span>` : ""}</td>
      <td data-label="Detail"><details><summary>${escapeHtml(detail.primary)}</summary><p>${escapeHtml(detail.primary)}</p>${ipHtml ? `<p>${ipHtml}</p>` : ""}</details></td>
    </tr>`;
  }).join("");
  document.querySelector("#content").innerHTML = `
    <div class="section-lead"><div><h2>${filtering ? `${events.length.toLocaleString()} matching events` : "Recent activity"}</h2><p>Sign-ins, imports, campaigns, and access changes.</p></div><div class="section-actions">${events.length ? `<button type="button" class="button" id="export-audit">Export CSV</button>` : ""}${filtering ? `<a class="button" href="#/audit">Clear filters</a>` : ""}</div></div>
    <div class="toolbar">
      ${searchField("audit-search", "Search audit log", params.get("q") || "", "Search actor, action, or detail")}
      <label>Action<select id="audit-action">${optionsHtml(AUDIT_ACTION_OPTIONS, params.get("action") || "")}</select></label>
      <label>Record<select id="audit-entity">${optionsHtml(AUDIT_ENTITY_OPTIONS, params.get("entity_type") || "")}</select></label>
      <div class="date-range"><label>From<input id="audit-from" type="date" value="${escapeHtml(params.get("from") || "")}" /></label><label>To<input id="audit-to" type="date" value="${escapeHtml(params.get("to") || "")}" /></label></div>
    </div>
    <section class="panel">${events.length ? `<div class="table-wrap"><table class="responsive"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><div><h2>${filtering ? "No matching events" : "No audit events yet"}</h2></div></div>`}</section>`;
  bindFilterInput("audit-search", "q", "audit");
  document.querySelector("#audit-action")?.addEventListener("change", (event) => setParam("audit", "action", event.target.value));
  document.querySelector("#audit-entity")?.addEventListener("change", (event) => setParam("audit", "entity_type", event.target.value));
  document.querySelector("#audit-from")?.addEventListener("change", (event) => setParam("audit", "from", event.target.value));
  document.querySelector("#audit-to")?.addEventListener("change", (event) => setParam("audit", "to", event.target.value));
  document.querySelector("#export-audit")?.addEventListener("click", () => exportAudit(events));
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportAudit(events) {
  const headers = ["created_at", "actor", "action", "entity_type", "entity_label", "entity_id", "detail", "ip"];
  const rows = events.map((event) => {
    const detail = formatAuditDetail(event.detail);
    return [event.created_at, event.actor_name || "System", event.action, event.entity_type, event.entity_label || "", event.entity_id || "", detail.primary === "—" ? "" : detail.primary, detail.ip || ""].map(csvEscape).join(",");
  });
  downloadText(`audit-${new Date().toISOString().slice(0, 10)}.csv`, [headers.join(","), ...rows].join("\n"));
  toast(`Exported ${events.length.toLocaleString()} events matching the current filters`);
}

function renderKit() {
  setChrome("_ui", "Components");
  document.querySelector("#content").innerHTML = `
    <div class="kit-grid">
      <section><h2>Buttons</h2><div class="kit-row"><button class="button primary">Primary</button><button class="button">Secondary</button><button class="button ghost">Ghost</button><button class="button danger">Danger</button><button class="button icon-button" aria-label="Close">${icon("close")}</button><button class="button primary is-loading" aria-busy="true">Loading</button></div></section>
      <section><h2>Fields</h2><div class="stack"><label>Text <span class="req">Required</span><input placeholder="Name" /></label>${searchField("kit-search", "Search", "", "Search")}<label>Select<select><option>Administrator</option></select></label><label class="dropzone">Drop a file<input type="file" /></label><div class="date-range"><label>From<input type="date" /></label><label>To<input type="date" /></label></div><label class="check"><input type="checkbox" /> Checkbox</label><label class="switch"><input type="checkbox" role="switch" /> Switch</label></div></section>
      <section><h2>Status</h2><div class="kit-row">${DELIVERY_STATUSES.map(([status]) => statusPill(status)).join("")}</div></section>
      <section><h2>Stat, table, empty</h2><article class="stat-card"><span class="stat-label">Sent today</span><strong class="stat-value">1,000</strong><span class="stat-detail">12 remaining</span></article><div class="empty-state panel"><div><h2>Nothing here</h2><p>Empty states explain the next step once.</p></div></div><div class="skeleton" style="width:180px"></div></section>
      <section><h2>Feedback</h2><div class="kit-row"><button type="button" class="button" id="kit-toast">Show toast</button><button type="button" class="button" id="kit-modal">Open modal</button><button type="button" class="button" id="kit-drawer">Open drawer</button></div><div class="notice" style="margin-top:12px"><div>Inline callout for a quiet explanation.</div></div></section>
      <section class="tabs" role="tablist"><button class="tab" aria-selected="true">Lists</button><button class="tab">Imports</button></section>
      <p class="help">Token contrast is recorded in docs/ui/DESIGN-TOKENS.md. This page is local only.</p>
    </div>`;
  document.querySelector("#kit-toast")?.addEventListener("click", () => toast("Saved"));
  document.querySelector("#kit-modal")?.addEventListener("click", () => openModal("Modal", "Example", "md", `<form class="stack"><label>Name <span class="req">Required</span><input required /></label><div class="form-actions"><button type="button" class="button" data-close-modal>Close</button></div></form>`));
  document.querySelector("#kit-drawer")?.addEventListener("click", () => openDrawer("Drawer", "Example", `<p>Side panel for a contact, delivery, or user.</p>`));
}

function openModal(title, kicker, size, html) {
  state.lastFocus = document.activeElement;
  const dialog = document.querySelector("#modal");
  dialog.dataset.size = size || "md";
  document.querySelector("#modal-title").textContent = title;
  document.querySelector("#modal-kicker").textContent = kicker || "";
  document.querySelector("#modal-body").innerHTML = html;
  document.querySelector("#modal-close").disabled = false;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("input, select, textarea, button")?.focus();
}

function closeModal() {
  const dialog = document.querySelector("#modal");
  if (dialog.open) dialog.close();
  document.querySelector("#modal-body").innerHTML = "";
  if (state.lastFocus?.focus) state.lastFocus.focus();
}

function openDrawer(title, kicker, html) {
  state.drawerFocus = state.drawerFocus || document.activeElement;
  document.querySelector("#drawer-title").textContent = title;
  document.querySelector("#drawer-kicker").textContent = kicker || "";
  document.querySelector("#drawer-body").innerHTML = html;
  document.querySelector("#drawer").hidden = false;
  document.querySelector("#drawer-close").focus();
}

function closeDrawer({ skipHash = false } = {}) {
  const drawer = document.querySelector("#drawer");
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  document.querySelector("#drawer-body").innerHTML = "";
  const focus = state.drawerFocus;
  state.drawerFocus = null;
  focus?.focus?.();
  if (!skipHash && state.route?.id && state.route.section !== "campaigns") go(state.route.section, "", state.route.params);
}

function openChangePassword(required = false) {
  openModal("Change password", required ? "Security" : "Account", "sm", `
    <form id="change-password-form" class="stack">
      <p class="help">${required ? "Set a new password before using the workspace." : "Use at least 12 characters."}</p>
      <label>Current password <span class="req">Required</span><input name="current_password" type="password" autocomplete="current-password" required /></label>
      <label>New password <span class="req">Required</span><input name="new_password" type="password" autocomplete="new-password" minlength="12" required /></label>
      <p class="form-error" role="alert"></p>
      <button class="button primary" type="submit">Save password</button>
    </form>`);
  if (required) document.querySelector("#modal-close").disabled = true;
  document.querySelector("#change-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await submitForm(form, () => api("/api/auth/change-password", { method: "POST", body: { current_password: form.current_password.value, new_password: form.new_password.value } }), "Password updated");
    if (!result) return;
    document.querySelector("#modal-close").disabled = false;
    closeModal();
    showApp(result);
  });
}

function setNav(open) {
  document.body.classList.toggle("nav-open", open);
  document.querySelector("#nav-backdrop").hidden = !open;
  document.querySelector("#mobile-nav-button")?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) document.querySelector("#nav-close")?.focus();
}

function setMenu(open) {
  const menu = document.querySelector("#account-menu");
  const button = document.querySelector("#account-button");
  menu.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");
}

function setStatusOpen(open) {
  document.querySelector("#status-popover").hidden = !open;
  document.querySelector("#status-button").setAttribute("aria-expanded", open ? "true" : "false");
}

function applyTheme(choice) {
  localStorage.setItem("ctn-theme", choice);
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = choice;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-checked", button.dataset.themeChoice === choice ? "true" : "false");
  });
}

function focusables(root) {
  return [...root.querySelectorAll("a, button, input, select, textarea, [tabindex]")].filter((node) => !node.disabled && node.tabIndex !== -1 && !node.closest("[hidden]"));
}

function trap(root, event) {
  if (event.key !== "Tab") return;
  const nodes = focusables(root);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function mountIcons() {
  document.querySelectorAll("[data-icon]").forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
  document.querySelector("#mobile-nav-button").innerHTML = icon("menu");
  document.querySelector("#nav-close").innerHTML = icon("close");
  document.querySelector("#modal-close").innerHTML = icon("close");
  document.querySelector("#drawer-close").innerHTML = icon("close");
  document.querySelector("#toggle-password").innerHTML = icon("eye");
}

function loginErrorMessage(error) {
  if (/invalid email or password|email or password/i.test(error.message || "")) return "Email or password is incorrect.";
  return error.message;
}

function bindShell() {
  mountIcons();
  applyTheme(localStorage.getItem("ctn-theme") || "system");
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.querySelector("#login-error");
    const submit = event.currentTarget.querySelector('[type="submit"]');
    error.textContent = "";
    setBusy(submit, true);
    submit.textContent = "Signing in";
    try {
      const session = await api("/api/auth/login", { method: "POST", body: { email: document.querySelector("#login-email").value, password: document.querySelector("#login-password").value } });
      showApp(session);
    } catch (requestError) {
      error.textContent = loginErrorMessage(requestError);
    } finally {
      setBusy(submit, false);
      submit.textContent = "Sign in";
    }
  });
  const password = document.querySelector("#login-password");
  password.addEventListener("keyup", (event) => {
    document.querySelector("#caps-lock-hint").hidden = !event.getModifierState?.("CapsLock");
  });
  document.querySelector("#toggle-password").addEventListener("click", () => {
    const button = document.querySelector("#toggle-password");
    const showing = password.type === "text";
    password.type = showing ? "password" : "text";
    button.setAttribute("aria-pressed", showing ? "false" : "true");
    button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    button.innerHTML = icon(showing ? "eye" : "eyeOff");
  });
  document.querySelector("#mobile-nav-button").addEventListener("click", () => setNav(true));
  document.querySelector("#nav-close").addEventListener("click", () => setNav(false));
  document.querySelector("#nav-backdrop").addEventListener("click", () => setNav(false));
  document.querySelector("#account-button").addEventListener("click", () => setMenu(document.querySelector("#account-menu").hidden));
  document.querySelectorAll("[data-theme-choice]").forEach((button) => button.addEventListener("click", () => applyTheme(button.dataset.themeChoice)));
  document.querySelector("#menu-password").addEventListener("click", () => { setMenu(false); openChangePassword(false); });
  document.querySelector("#logout-button").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch (_) { /* still sign out locally */ }
    setMenu(false);
    showLogin();
  });
  document.querySelector("#status-button").addEventListener("click", () => setStatusOpen(document.querySelector("#status-popover").hidden));
  document.querySelector("#global-new-campaign").addEventListener("click", () => { if (can("campaigns.manage")) go("campaigns", "new"); });
  document.querySelector("#modal-close").addEventListener("click", closeModal);
  document.querySelector("#modal").addEventListener("click", (event) => { if (event.target.id === "modal") closeModal(); });
  document.querySelector("#modal").addEventListener("cancel", (event) => {
    if (document.querySelector("#modal-close").disabled) { event.preventDefault(); return; }
    event.preventDefault();
    closeModal();
  });
  document.querySelector("#modal").addEventListener("click", (event) => {
    if (event.target.closest("[data-close-modal]")) closeModal();
  });
  document.querySelector("#drawer-close").addEventListener("click", () => closeDrawer());
  document.querySelector("#drawer").addEventListener("click", (event) => {
    if (event.target.closest("[data-close-drawer]")) closeDrawer();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#account-button") && !event.target.closest("#account-menu")) setMenu(false);
    if (!event.target.closest(".status-wrap")) setStatusOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (document.body.classList.contains("nav-open")) { setNav(false); return; }
      if (!document.querySelector("#account-menu").hidden) { setMenu(false); return; }
      if (!document.querySelector("#status-popover").hidden) { setStatusOpen(false); return; }
      if (!document.querySelector("#drawer").hidden) { closeDrawer(); return; }
    }
    if (document.body.classList.contains("nav-open")) trap(document.querySelector("#sidebar"), event);
    if (!document.querySelector("#drawer").hidden) trap(document.querySelector(".drawer-panel"), event);
  });
  window.addEventListener("hashchange", onRoute);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(state.pollTimer);
    else schedulePoll(0);
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.composerDirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function initialize() {
  bindShell();
  try {
    const session = await api("/api/session");
    showApp(session);
  } catch (_) {
    showLogin();
    if (isLocalHost() && location.hash.startsWith("#/_ui")) onRoute();
  }
}

initialize();
