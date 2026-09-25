const state = {
  session: null,
  csrf: "",
  currentView: "dashboard",
  lists: [],
  users: [],
  roles: [],
  permissionDefinitions: [],
  pollTimer: null,
  deliveryFilters: {
    campaignId: null,
    q: "",
    status: "",
    from: "",
    to: "",
  },
  auditFilters: {
    action: "",
    entityType: "",
    q: "",
    from: "",
    to: "",
  },
};

const els = {
  loginScreen: document.querySelector("#login-screen"),
  appShell: document.querySelector("#app-shell"),
  loginForm: document.querySelector("#login-form"),
  loginError: document.querySelector("#login-error"),
  content: document.querySelector("#content"),
  pageTitle: document.querySelector("#page-title"),
  pageKicker: document.querySelector("#page-kicker"),
  nav: document.querySelector("#main-nav"),
  modal: document.querySelector("#modal"),
  modalBody: document.querySelector("#modal-body"),
  modalTitle: document.querySelector("#modal-title"),
  modalKicker: document.querySelector("#modal-kicker"),
  toastRegion: document.querySelector("#toast-region"),
  modePill: document.querySelector("#mode-pill"),
  queueStatus: document.querySelector("#queue-status"),
};

const viewMeta = {
  dashboard: ["Overview", "Operations"],
  contacts: ["Contacts", "Audience"],
  campaigns: ["Campaigns", "Delivery"],
  sending: ["Sending setup", "Production readiness"],
  deliveries: ["Deliveries", "Message activity"],
  suppressions: ["Suppressions", "Safety controls"],
  users: ["Users & roles", "Access control"],
  audit: ["Audit log", "Governance"],
};

const viewPermissions = {
  contacts: "contacts.view",
  campaigns: "campaigns.view",
  sending: "sending.view",
  deliveries: "deliveries.view",
  suppressions: "suppressions.view",
  users: "users.view",
  audit: "audit.view",
};

function can(permission) {
  return Boolean(state.session?.permissions?.includes(permission));
}

const defaultTemplate = `<!doctype html>
<html>
  <body style="margin:0;background:#f1f5fb;font-family:Arial,sans-serif;color:#14213d">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5fb;padding:32px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:white;border-radius:14px;overflow:hidden">
          <tr><td style="padding:26px 30px;background:#0f7a72;color:white;font-size:20px;font-weight:bold">CTN</td></tr>
          <tr><td style="padding:34px 30px">
            <p style="margin:0 0 14px;font-size:16px">Hello {{first_name}},</p>
            <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">A useful update from CTN.</h1>
            <p style="margin:0 0 22px;color:#53627a;line-height:1.65">Replace this text with the message you want your audience to receive. Preview shows the fully personalized result.</p>
            <a href="#" style="display:inline-block;background:#0f7a72;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">Learn more</a>
          </td></tr>
          <tr><td style="padding:21px 30px;background:#f7f9fc;color:#718097;font-size:12px;line-height:1.6">You are receiving this because you opted in to updates.<br><a href="{{unsubscribe_url}}" style="color:#0f7a72">Unsubscribe</a></td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

const defaultVisualContent = {
  schema_version: 1,
  template: "announcement",
  brand_name: "CTN",
  preheader: "A short update for you",
  headline: "A useful update from CTN",
  body: "Write the message your audience should read. The preview on the right updates as you type.",
  cta_label: "Learn more",
  cta_url: "https://ctn-sk.com",
  accent_color: "#0f7a72",
  footer: "You are receiving this because you opted in to updates.",
};

const defaultRichContent = `<h1>A useful update from CTN</h1><p>Hello {{first_name}},</p><p>Write your message here. Use the toolbar for emphasis and lists without touching HTML.</p><p><strong>Thank you for reading.</strong></p>`;

const defaultPlainContent = "Hello {{first_name}},\n\nWrite your message here.\n\nUnsubscribe: {{unsubscribe_url}}";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeContentObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) { /* legacy campaign metadata falls back safely */ }
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
  container.innerHTML = sanitizeRichHtml(markup)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|li|blockquote)>/gi, "\n");
  return (container.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function visualEmailContent(input) {
  const data = { ...defaultVisualContent, ...(input || {}), schema_version: 1 };
  const accent = /^#[0-9a-f]{6}$/i.test(data.accent_color || "") ? data.accent_color : defaultVisualContent.accent_color;
  const template = ["announcement", "newsletter", "simple"].includes(data.template) ? data.template : "announcement";
  const background = template === "simple" ? "#ffffff" : "#f1f5fb";
  const headerBackground = template === "simple" ? "#ffffff" : template === "newsletter" ? accent : "#172952";
  const headerColor = template === "simple" ? "#14213d" : "#ffffff";
  const cardBorder = template === "simple" ? "1px solid #dfe6f1" : "0";
  const paragraphs = escapeHtml(data.body).split(/\n{2,}/).map((paragraph) => `<p style="margin:0 0 16px;color:#53627a;line-height:1.65">${paragraph.replaceAll("\n", "<br>")}</p>`).join("");
  const ctaUrl = safeComposerUrl(data.cta_url);
  const cta = data.cta_label && ctaUrl ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">${escapeHtml(data.cta_label)}</a>` : "";
  const htmlBody = `<!doctype html><html><body style="margin:0;background:${background};font-family:Arial,sans-serif;color:#14213d"><div style="display:none;max-height:0;overflow:hidden;color:transparent">${escapeHtml(data.preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${background};padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:${cardBorder};border-radius:14px;overflow:hidden"><tr><td style="padding:26px 30px;background:${headerBackground};color:${headerColor};font-size:20px;font-weight:bold">${escapeHtml(data.brand_name)}</td></tr><tr><td style="padding:34px 30px"><p style="margin:0 0 14px;font-size:16px">Hello {{first_name}},</p><h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">${escapeHtml(data.headline)}</h1>${paragraphs}${cta}</td></tr><tr><td style="padding:21px 30px;background:#f7f9fc;color:#718097;font-size:12px;line-height:1.6">${escapeHtml(data.footer)}<br><a href="{{unsubscribe_url}}" style="color:${accent}">Unsubscribe</a></td></tr></table></td></tr></table></body></html>`;
  const textParts = [data.brand_name, `Hello {{first_name}},`, data.headline, data.body];
  if (data.cta_label && ctaUrl) textParts.push(`${data.cta_label}: ${ctaUrl}`);
  textParts.push(data.footer, "Unsubscribe: {{unsubscribe_url}}");
  return { html_body: htmlBody, text_body: textParts.filter(Boolean).join("\n\n"), content_json: data };
}

function richEmailContent(input) {
  const richHtml = sanitizeRichHtml(input?.rich_html || defaultRichContent);
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f1f5fb;font-family:Arial,sans-serif;color:#14213d"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:14px"><tr><td style="padding:34px 30px;line-height:1.65">${richHtml}</td></tr><tr><td style="padding:20px 30px;background:#f7f9fc;color:#718097;font-size:12px">You are receiving this because you opted in.<br><a href="{{unsubscribe_url}}" style="color:#536fd9">Unsubscribe</a></td></tr></table></td></tr></table></body></html>`;
  const text = richHtmlToText(richHtml);
  return { html_body: htmlBody, text_body: `${text}\n\nUnsubscribe: {{unsubscribe_url}}`, content_json: { schema_version: 1, rich_html: richHtml } };
}

function plainEmailContent(input) {
  let text = String(input?.plain_text || "Hello {{first_name}},\n\nWrite your message here.").trim();
  if (!text.includes("{{unsubscribe_url}}")) text += "\n\nUnsubscribe: {{unsubscribe_url}}";
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f1f5fb;font-family:Arial,sans-serif;color:#14213d"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px"><tr><td align="center"><div style="max-width:600px;background:#ffffff;border-radius:12px;padding:30px;white-space:pre-wrap;line-height:1.65">${escapeHtml(text).replaceAll("\n", "<br>")}</div></td></tr></table></body></html>`;
  return { html_body: htmlBody, text_body: text, content_json: { schema_version: 1, plain_text: text } };
}

function buildCampaignContent(mode, draft) {
  if (mode === "visual") return visualEmailContent(draft);
  if (mode === "rich_text") return richEmailContent(draft);
  if (mode === "plain_text") return plainEmailContent(draft);
  return {
    html_body: String(draft?.html_body || defaultTemplate),
    text_body: String(draft?.text_body || "Hello {{first_name}},\n\nWrite your message here.\n\nUnsubscribe: {{unsubscribe_url}}"),
    content_json: { schema_version: 1 },
  };
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function titleCase(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

const AUDIT_DETAIL_OMIT = new Set(["ip", "user_agent"]);
const AUDIT_DETAIL_ORDER = [
  "email",
  "name",
  "role",
  "active",
  "status",
  "recipients",
  "reason",
  "consent_source",
  "content_mode",
  "delivery_mode",
];

function formatAuditDetailValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatAuditDetail(detail) {
  const source = detail && typeof detail === "object" ? detail : {};
  const preferred = [];
  const seen = new Set();
  for (const key of AUDIT_DETAIL_ORDER) {
    if (!(key in source) || AUDIT_DETAIL_OMIT.has(key)) continue;
    const formatted = formatAuditDetailValue(source[key]);
    if (formatted === null) continue;
    preferred.push(`${titleCase(key)}: ${formatted}`);
    seen.add(key);
  }
  const leftovers = Object.keys(source)
    .filter((key) => !AUDIT_DETAIL_OMIT.has(key) && !seen.has(key))
    .sort()
    .map((key) => {
      const formatted = formatAuditDetailValue(source[key]);
      return formatted === null ? null : `${titleCase(key)}: ${formatted}`;
    })
    .filter(Boolean);
  const primary = [...preferred, ...leftovers].join(" · ") || "—";
  const ip = typeof source.ip === "string" && source.ip && source.ip !== "unknown" ? source.ip : "";
  return { primary, ip };
}

function statusPill(status, { title } = {}) {
  const safe = String(status || "unknown").toLowerCase();
  const labels = {
    sandboxed: "Captured",
    captured: "Captured",
    submitted: "Submitted",
    delivered: "Delivered",
    bounced: "Bounced",
    complained: "Complained",
    suppressed: "Suppressed",
    unsubscribed: "Unsubscribed",
    queued: "Queued",
    sending: "Sending",
    paused: "Paused",
    completed: "Completed",
    draft: "Draft",
    failed: "Failed",
    active: "Active",
    inactive: "Inactive",
  };
  const label = labels[safe] || titleCase(safe);
  const tip = title || deliveryStatusMeaning(safe);
  const titleAttr = tip ? ` title="${escapeHtml(tip)}"` : "";
  return `<span class="status ${escapeHtml(safe)}"${titleAttr}>${escapeHtml(label)}</span>`;
}

function deliveryStatusMeaning(status) {
  switch (String(status || "").toLowerCase()) {
    case "captured":
    case "sandboxed":
      return "Stored in this workspace only — no email left the app";
    case "submitted":
      return "Accepted by the delivery service — not proof it reached the inbox";
    case "delivered":
      return "Delivery provider confirmed handoff to the recipient mailbox";
    case "failed":
      return "Send attempt failed before the provider accepted it";
    case "bounced":
      return "Hard bounce — address rejected; recipient is suppressed";
    case "complained":
      return "Marked as spam — recipient is suppressed";
    case "unsubscribed":
      return "Recipient opted out via unsubscribe";
    case "suppressed":
      return "Skipped because the address is on the suppression list";
    default:
      return "";
  }
}

function deliveryStatusLegend(live) {
  const items = live
    ? [
        ["submitted", "Accepted by provider — not inbox proof"],
        ["delivered", "Confirmed handoff to the mailbox"],
        ["bounced", "Rejected address · suppressed"],
        ["complained", "Marked spam · suppressed"],
        ["failed", "Send failed before accept"],
      ]
    : [
        ["captured", "Stored here only — not mailed"],
        ["submitted", "Accepted by provider"],
        ["bounced", "Rejected address · suppressed"],
        ["failed", "Send failed before accept"],
      ];
  return `<div class="status-legend" role="list">${items.map(([status, meaning]) => `
    <div class="status-legend-item" role="listitem">${statusPill(status)}<span>${escapeHtml(meaning)}</span></div>`).join("")}</div>`;
}

function deliveryModeLabel(mode) {
  if (mode === "resend") return "Resend";
  if (mode === "smtp") return "Allowlisted SMTP";
  return "Preview";
}

function deliveryStatusLabel(mode = state.session?.delivery_mode) {
  return mode === "resend" ? "LIVE" : "Dev Mode";
}

function isLiveDelivery(mode = state.session?.delivery_mode) {
  return mode === "resend";
}

function testSendNotice(mode = state.session?.delivery_mode) {
  if (isLiveDelivery(mode)) {
    return "LIVE: this sends a real email to the address you enter. It will leave this workspace.";
  }
  if (mode === "smtp") {
    return "Dev Mode: delivery is limited to approved test addresses.";
  }
  return "Dev Mode: the message is captured in Deliveries. No email leaves the app.";
}

function testSendSuccessMessage(email, mode = state.session?.delivery_mode) {
  if (isLiveDelivery(mode)) {
    return `Live preview submitted to ${email}`;
  }
  return `Preview captured for ${email} — open Deliveries to inspect it`;
}

function launchConfirmCopy(mode = state.session?.delivery_mode) {
  const live = isLiveDelivery(mode);
  return {
    title: live ? "Send live to audience?" : "Send in Dev Mode?",
    notice: live
      ? "LIVE: eligible recipients will receive a real email."
      : "Dev Mode: messages are captured in this workspace. No email leaves the app.",
    confirm: live ? "Send to real recipients" : "Start Dev Mode send",
    outcome: live
      ? "After you confirm, delivery starts immediately for eligible recipients."
      : "After you confirm, messages appear in Deliveries as Captured.",
  };
}

function launchOutcomeMessage(result, mode = state.session?.delivery_mode) {
  const queued = Number(result?.queued ?? 0);
  const sent = Number(result?.sent ?? queued);
  const failed = Number(result?.failed ?? 0);
  if (isLiveDelivery(mode)) {
    if (failed) return `Live send started: ${queued} queued · ${failed} failed`;
    return queued === 1 ? "Live send started for 1 recipient" : `Live send started for ${queued} recipients`;
  }
  if (failed) return `Dev Mode send finished: ${sent} captured · ${failed} failed`;
  if (sent === 0) return "Dev Mode send finished — no eligible recipients";
  return sent === 1 ? "Dev Mode: 1 message captured in Deliveries" : `Dev Mode: ${sent} messages captured in Deliveries`;
}

function initials(name) {
  return String(name || "User")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  els.toastRegion.append(item);
  setTimeout(() => item.remove(), 4200);
}

async function api(path, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  const isFormData = typeof FormData !== "undefined" && request.body instanceof FormData;
  if (request.body && typeof request.body !== "string" && !isFormData) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(request.body);
  }
  if (request.method && request.method !== "GET" && state.csrf) {
    request.headers["X-CSRF-Token"] = state.csrf;
  }
  const response = await fetch(path, request);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (response.status === 401 && path !== "/api/auth/login") {
    showLogin();
    throw new Error("Your session has ended. Sign in again.");
  }
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return data;
}

const ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.zip";
const ATTACHMENT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_MAX_COUNT = 3;
const ATTACHMENT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

function formatByteSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentListMarkup(attachments, { editable = false } = {}) {
  if (!attachments?.length) {
    return `<p class="help attachment-empty">${editable ? "No files attached yet. Drop files here or use Add files." : "No attachments."}</p>`;
  }
  return `<ul class="attachment-list">${attachments.map((file) => `
    <li class="attachment-item">
      <div><strong>${escapeHtml(file.filename)}</strong><span class="subtext">${escapeHtml(formatByteSize(file.byte_size))} · uploaded</span></div>
      ${editable ? `<button type="button" class="button small ghost" data-remove-attachment="${escapeHtml(file.id)}">Remove</button>` : ""}
    </li>`).join("")}</ul>`;
}

function pendingAttachmentListMarkup(pendingFiles) {
  if (!pendingFiles.length) {
    return `<p class="help attachment-empty">No files yet. Drop files here or use Add files — they upload when you save the draft.</p>`;
  }
  return `<ul class="attachment-list">${pendingFiles.map((file, index) => `
    <li class="attachment-item pending">
      <div><strong>${escapeHtml(file.name)}</strong><span class="subtext">${escapeHtml(formatByteSize(file.size))} · uploads on save</span></div>
      <button type="button" class="button small ghost" data-remove-pending="${index}">Remove</button>
    </li>`).join("")}</ul>`;
}

function attachmentMeterMarkup(count, bytes) {
  const countPct = Math.min(100, Math.round((count / ATTACHMENT_MAX_COUNT) * 100));
  const bytesPct = Math.min(100, Math.round((bytes / ATTACHMENT_MAX_TOTAL_BYTES) * 100));
  const remaining = Math.max(0, ATTACHMENT_MAX_TOTAL_BYTES - bytes);
  return `<div class="attachment-meter" aria-live="polite">
    <div class="attachment-meter-row"><span>${count} / ${ATTACHMENT_MAX_COUNT} files</span><span>${formatByteSize(bytes)} / ${formatByteSize(ATTACHMENT_MAX_TOTAL_BYTES)}</span></div>
    <div class="attachment-meter-bars" aria-hidden="true">
      <span class="attachment-meter-bar" style="width:${countPct}%"></span>
      <span class="attachment-meter-bar bytes" style="width:${bytesPct}%"></span>
    </div>
    <p class="help">${remaining > 0 ? `${formatByteSize(remaining)} remaining · PNG, JPG, GIF, WebP, PDF, or ZIP · 5 MB per file` : "Attachment limit reached"}</p>
  </div>`;
}

function showLogin() {
  state.session = null;
  state.csrf = "";
  clearInterval(state.pollTimer);
  els.appShell.hidden = true;
  els.loginScreen.hidden = false;
  document.querySelector("#login-email")?.focus();
}

function showApp(sessionData) {
  state.session = sessionData;
  state.csrf = sessionData.csrf_token;
  els.loginScreen.hidden = true;
  els.appShell.hidden = false;
  const user = sessionData.user;
  document.querySelector("#user-name").textContent = user.name;
  document.querySelector("#user-role").textContent = user.role_label || titleCase(user.role);
  document.querySelector("#user-initials").textContent = initials(user.name);
  document.querySelectorAll("[data-permission]").forEach((element) => {
    element.hidden = !can(element.dataset.permission);
  });
  els.modePill.innerHTML = `<span></span> ${deliveryStatusLabel(sessionData.delivery_mode)}`;
  els.modePill.dataset.status = sessionData.delivery_mode === "resend" ? "live" : "dev";
  if (sessionData.must_change_password || user?.must_change_password) {
    openChangePasswordModal(true);
    return;
  }
  startPolling();
  navigate(state.currentView || "dashboard");
}

function openChangePasswordModal(required = false) {
  openModal(
    "Change password",
    required ? "Security" : "Account",
    `<form id="change-password-form" class="stack">
      <p class="subtext">${required ? "You must set a new password before using SendStack." : "Update your account password."}</p>
      <label>Current password<input name="current_password" type="password" autocomplete="current-password" required /></label>
      <label>New password<input name="new_password" type="password" autocomplete="new-password" minlength="12" required /></label>
      <p class="form-error" role="alert"></p>
      <button class="button primary" type="submit">Save password</button>
    </form>`,
  );
  if (required) {
    document.querySelector("#modal-close")?.setAttribute("disabled", "true");
  }
  const form = document.querySelector("#change-password-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await submitForm(form, () =>
      api("/api/auth/change-password", {
        method: "POST",
        body: {
          current_password: form.current_password.value,
          new_password: form.new_password.value,
        },
      }), "Password updated");
    if (result) {
      document.querySelector("#modal-close")?.removeAttribute("disabled");
      closeModal();
      showApp(result);
    }
  });
}

function setLoading() {
  els.content.innerHTML = `<div class="loading-grid" aria-label="Loading"><div></div><div></div><div></div></div>`;
}

function setEmpty(icon, title, copy, actionHtml = "") {
  els.content.innerHTML = `<section class="panel empty-state"><div><div class="empty-mark">${icon}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p>${actionHtml}</div></section>`;
}

async function navigate(view) {
  if (!viewMeta[view]) view = "dashboard";
  if (viewPermissions[view] && !can(viewPermissions[view])) {
    toast("You don’t have permission to open that section.", "error");
    view = "dashboard";
  }
  state.currentView = view;
  document.body.classList.remove("nav-open");
  els.nav.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  els.pageTitle.textContent = viewMeta[view][0];
  els.pageKicker.textContent = viewMeta[view][1];
  setLoading();
  els.content.focus({ preventScroll: true });
  try {
    if (view === "dashboard") await renderDashboard();
    if (view === "contacts") await renderContacts();
    if (view === "campaigns") await renderCampaigns();
    if (view === "sending") await renderSendingSetup();
    if (view === "deliveries") await renderDeliveries();
    if (view === "suppressions") await renderSuppressions();
    if (view === "users") await renderUsers();
    if (view === "audit") await renderAudit();
  } catch (error) {
    renderError(error);
  }
}

function renderError(error) {
  els.content.innerHTML = `<div class="notice warning"><span>!</span><div><strong>Couldn’t load this view.</strong><br>${escapeHtml(error.message)}</div></div>`;
}

async function getLists(force = false) {
  if (!state.lists.length || force) {
    state.lists = (await api("/api/lists")).lists;
  }
  return state.lists;
}

function updateQueueStatus(summary) {
  const queued = summary.counts?.queued || 0;
  els.queueStatus.innerHTML = `<span></span><strong>${queued ? `${queued} queued` : "Queue clear"}</strong>`;
  els.queueStatus.querySelector("span").style.background = queued ? "#f3b65a" : "#50d4c2";
}

function startPolling() {
  clearInterval(state.pollTimer);
  const poll = async () => {
    if (!state.session || document.hidden) return;
    try {
      const summary = await api("/api/summary");
      updateQueueStatus(summary);
    } catch (_) {
      // Authentication handling occurs in api(); transient polling errors stay quiet.
    }
  };
  poll();
  state.pollTimer = setInterval(poll, 3000);
}

async function renderDashboard() {
  const data = await api("/api/summary");
  updateQueueStatus(data);
  const remaining = Math.max(0, data.daily_limit - data.counts.sent_today);
  els.content.innerHTML = `
    <section class="stat-grid" aria-label="Delivery overview">
      <article class="stat-card"><span class="stat-label">Active contacts</span><strong class="stat-value">${data.counts.contacts.toLocaleString()}</strong><span class="stat-detail">Ready for eligible campaigns</span></article>
      <article class="stat-card" style="--stat-glow:rgba(80,212,194,.15)"><span class="stat-label">Sent today</span><strong class="stat-value">${data.counts.sent_today.toLocaleString()}</strong><span class="stat-detail"><strong>${remaining.toLocaleString()}</strong> remaining under today’s limit</span></article>
      <article class="stat-card" style="--stat-glow:rgba(243,182,90,.14)"><span class="stat-label">Queue</span><strong class="stat-value">${data.counts.queued.toLocaleString()}</strong><span class="stat-detail">Messages waiting or processing</span></article>
      <article class="stat-card" style="--stat-glow:rgba(255,111,125,.12)"><span class="stat-label">Suppressed</span><strong class="stat-value">${data.counts.suppressed.toLocaleString()}</strong><span class="stat-detail">Globally excluded before delivery</span></article>
    </section>
    <div class="two-column">
      <section class="panel">
        <div class="panel-head"><div><h2>Recent campaigns</h2><p>Latest audience runs and current states</p></div><button class="button small ghost" data-go="campaigns">View all</button></div>
        ${renderRecentCampaignTable(data.recent_campaigns)}
      </section>
      ${can("deliveries.view") ? `<section class="panel">
        <div class="panel-head"><div><h2>Latest messages</h2><p>${escapeHtml(deliveryStatusLabel(data.delivery_mode))} delivery activity</p></div><button class="button small ghost" data-go="deliveries">Open inbox</button></div>
        <div class="panel-body">${renderRecentMessages(data.recent_messages)}</div>
      </section>` : `<section class="panel access-summary"><div class="panel-body"><div class="access-lock">◌</div><h2>Recipient data is protected</h2><p>Your Analyst role includes aggregate campaign reporting without contact addresses or message contents.</p></div></section>`}
    </div>
    ${can("sending.view") ? `<section class="production-target-strip" data-status="${data.delivery_mode === "resend" ? "live" : "dev"}">
      <div class="target-strip-copy"><span class="readiness-status ${data.delivery_mode === "resend" ? "ready" : "pending"}">${escapeHtml(deliveryStatusLabel(data.delivery_mode))}</span><div><strong>${data.delivery_mode === "resend" ? "Live delivery is on" : "Workspace is in Dev Mode"}</strong><p>${data.delivery_mode === "resend" ? "Campaigns and previews can reach real mailboxes. Review setup anytime if something looks off." : "Messages stay inside this workspace until an administrator turns on live delivery."}</p></div></div>
      <button class="button" data-go="sending">Open setup</button>
    </section>` : ""}
    <div class="notice" style="margin-top:16px"><span>i</span><div><strong>${data.delivery_mode === "resend" ? "Live delivery is active." : "Dev Mode is active."}</strong> ${data.delivery_mode === "resend" ? "Outbound messages can leave this workspace." : "Messages stay within this workspace until live delivery is enabled."}</div></div>`;
}

function readinessStatusLabel(status) {
  const labels = {
    ready: "Ready",
    pending: "Pending",
    migration_required: "Setup required",
    not_connected: "Not connected",
    not_verified: "Not verified",
    configured_locked: "Configured (live off)",
    configured: "Configured",
  };
  return labels[status] || titleCase(status);
}

function checkById(checks, id) {
  return checks.find((check) => check.id === id) || { status: "pending", detail: "" };
}

async function renderSendingSetup() {
  const data = await api("/api/production-readiness");
  const target = data.target;
  const readyCount = data.checks.filter((check) => check.status === "ready").length;
  const vercel = checkById(data.checks, "vercel_runtime");
  const postgres = checkById(data.checks, "postgres_database");
  const resend = checkById(data.checks, "resend_broadcasts");
  const liveReady = Boolean(data.ready_for_live_sending);
  els.content.innerHTML = `
    <section class="production-hero">
      <div>
        <span class="readiness-status ${liveReady ? "ready" : "pending"}">${liveReady ? "Live email on" : "Live email off"}</span>
        <p class="eyebrow">DELIVERY ARCHITECTURE</p>
        <h2>${escapeHtml(target.platform)} + ${escapeHtml(target.database)} + ${escapeHtml(target.provider)}</h2>
        <p>Current runtime: ${escapeHtml(data.current.runtime)}. Database: ${escapeHtml(data.current.database)}. Transport: ${escapeHtml(deliveryModeLabel(data.current.transport))}.</p>
      </div>
      <div class="readiness-score"><strong>${readyCount}/${data.checks.length}</strong><span>setup checks complete</span></div>
    </section>

    <section class="target-grid" aria-label="Delivery architecture">
      <article class="target-card"><span class="target-card-index">01</span><h3>Vercel</h3><p>${escapeHtml(vercel.detail)}</p><span class="readiness-status ${vercel.status === "ready" ? "ready" : "pending"}">${escapeHtml(readinessStatusLabel(vercel.status))}</span></article>
      <article class="target-card"><span class="target-card-index">02</span><h3>PostgreSQL</h3><p>${escapeHtml(postgres.detail)}</p><span class="readiness-status ${postgres.status === "ready" ? "ready" : "pending"}">${escapeHtml(readinessStatusLabel(postgres.status))}</span></article>
      <article class="target-card"><span class="target-card-index">03</span><h3>Resend Broadcasts</h3><p>${escapeHtml(resend.detail)}</p><span class="readiness-status ${resend.status === "ready" ? "ready" : "pending"}">${escapeHtml(readinessStatusLabel(resend.status))}</span></article>
    </section>

    <div class="readiness-layout">
      <section class="panel">
        <div class="panel-head"><div><h2>Delivery readiness</h2><p>Every item is checked before production delivery is enabled</p></div><span class="readiness-status ${liveReady ? "ready" : "locked"}">${liveReady ? "Ready for delivery" : "Preview mode"}</span></div>
        <div class="readiness-list">${data.checks.map((check) => `
          <div class="readiness-item">
            <span class="readiness-marker ${escapeHtml(check.status)}">${check.status === "ready" ? "✓" : ""}</span>
            <div><strong>${escapeHtml(check.label)}</strong><p>${escapeHtml(check.detail)}</p></div>
            <span class="readiness-status ${check.status === "ready" ? "ready" : "pending"}">${escapeHtml(readinessStatusLabel(check.status))}</span>
          </div>`).join("")}</div>
      </section>

      <div class="readiness-side">
        <section class="panel">
          <div class="panel-head"><div><h2>Delivery path</h2><p>How a campaign reaches the provider</p></div></div>
          <ol class="delivery-path">${data.delivery_path.map((step, index) => `<li><span>${index + 1}</span><p>${escapeHtml(step)}</p></li>`).join("")}</ol>
        </section>
        <section class="panel volume-plan">
          <div class="panel-head"><div><h2>Volume goal</h2><p>Operating target after a careful ramp</p></div></div>
          <div class="panel-body"><strong class="volume-goal">${escapeHtml(data.volume_plan.goal)}</strong><p>${escapeHtml(data.volume_plan.launch_policy)}</p><div class="notice warning"><span>!</span><div>Bounce, complaint, and unsubscribe signals must remain healthy before volume increases.</div></div></div>
        </section>
      </div>
    </div>

    <div class="notice setup-note"><span>i</span><div><strong>DNS can remain with your existing provider.</strong> Vercel runs the application; Resend handles email delivery. DNS hosting does not replace either service.</div></div>`;
}

function renderRecentCampaignTable(campaigns) {
  if (!campaigns.length) return `<div class="empty-state"><div><p>No campaigns yet.</p>${can("campaigns.manage") ? `<button class="button primary" data-new-campaign>Create campaign</button>` : ""}</div></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th>Issues</th></tr></thead><tbody>${campaigns.map((campaign) => {
    const recipients = Number(campaign.recipients || 0);
    const sent = Number(campaign.sent || 0);
    const progress = recipients ? Math.round((sent / recipients) * 100) : 0;
    return `<tr><td><strong>${escapeHtml(campaign.name)}</strong><span class="subtext">${escapeHtml(campaign.subject)}</span></td><td>${statusPill(campaign.status)}</td><td><span class="subtext">${sent}/${recipients}</span><div class="progress"><span style="width:${progress}%"></span></div></td><td>${Number(campaign.issues || 0)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderRecentMessages(messages) {
  if (!messages.length) return `<div class="empty-state" style="min-height:180px;padding:20px"><div><p>Messages will appear here after a preview or campaign delivery.</p></div></div>`;
  return `<div class="activity-list">${messages.map((message) => `<div class="activity-item"><div class="activity-icon">↗</div><div><strong>${escapeHtml(message.to_email)}</strong><p>${escapeHtml(message.subject)} · ${formatDate(message.created_at)}</p></div></div>`).join("")}</div>`;
}

async function renderContacts(query = "", listId = "") {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (listId) params.set("list_id", listId);
  const queryString = params.toString();
  const [data, lists] = await Promise.all([
    api(`/api/contacts${queryString ? `?${queryString}` : ""}`),
    getLists(),
  ]);
  const canManage = can("contacts.manage");
  const canEdit = can("contacts.edit");
  const contacts = data.contacts || [];
  const activeListId = data.list_id || listId || "";
  const activeCount = contacts.filter((contact) => contact.status === "active").length;
  const suppressedCount = contacts.filter((contact) => contact.status === "suppressed").length;
  const searching = Boolean(query);
  const filtering = Boolean(activeListId);
  const activeList = lists.find((list) => list.id === activeListId);
  const listSummary = lists.length
    ? lists.slice(0, 6).map((list) => `<span class="list-chip">${escapeHtml(list.name)}<em>${Number(list.contact_count || 0)}</em></span>`).join("")
    : `<span class="list-chip muted">No lists yet</span>`;
  const listFilterOptions = [
    `<option value="">All lists</option>`,
    ...lists.map((list) => `<option value="${escapeHtml(list.id)}" ${list.id === activeListId ? "selected" : ""}>${escapeHtml(list.name)} (${Number(list.contact_count || 0)})</option>`),
  ].join("");

  const tableRows = contacts.map((contact) => {
    const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Unnamed contact";
    const listNames = String(contact.lists || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    return `<tr data-contact-id="${escapeHtml(contact.id)}">
      <td>
        <div class="contact-identity">
          <span class="contact-avatar" aria-hidden="true">${escapeHtml(initials(displayName === "Unnamed contact" ? contact.email : displayName))}</span>
          <div>
            <strong>${escapeHtml(displayName)}</strong>
            <span class="subtext email">${escapeHtml(contact.email)}</span>
          </div>
        </div>
      </td>
      <td>${listNames.length ? `<div class="list-chip-row">${listNames.map((name) => `<span class="list-chip">${escapeHtml(name)}</span>`).join("")}</div>` : `<span class="muted-dash">—</span>`}</td>
      <td><span class="consent-tag">${escapeHtml(titleCase(contact.consent_source))}</span></td>
      <td>${statusPill(contact.status)}</td>
      <td><span class="date-cell">${formatDate(contact.created_at)}</span></td>
      <td class="table-actions">
        <button class="button small ghost" data-contact-view="${escapeHtml(contact.id)}">View</button>
        ${canEdit ? `<button class="button small ghost" data-contact-edit="${escapeHtml(contact.id)}">Edit</button><button class="button small ghost danger-text" data-contact-delete="${escapeHtml(contact.id)}">Delete</button>` : ""}
      </td>
    </tr>`;
  }).join("");

  let emptyMarkup;
  if (searching || filtering) {
    emptyMarkup = `<div class="empty-state contacts-empty"><div><div class="empty-mark">⌕</div><h2>${searching ? `No matches for “${escapeHtml(query)}”` : "No contacts in this list"}</h2><p>${filtering && searching ? `Nothing found in ${escapeHtml(activeList?.name || "this list")}.` : filtering ? "Try another list, or clear the filter to see everyone." : "Try another email or name, or clear the search to see everyone."}</p><button class="button" id="clear-contact-filters">Clear filters</button></div></div>`;
  } else {
    emptyMarkup = `<div class="empty-state contacts-empty"><div><div class="empty-mark">◎</div><h2>No contacts yet</h2><p>Add someone manually or import a consented CSV audience to get started.</p>${canManage ? `<div class="empty-actions"><button class="button" id="empty-import-contacts">Import CSV</button><button class="button primary" id="empty-add-contact">Add contact</button></div>` : ""}</div></div>`;
  }

  const subtitle = searching
    ? `${contacts.length.toLocaleString()} match${contacts.length === 1 ? "" : "es"} for “${escapeHtml(query)}”${activeList ? ` in ${escapeHtml(activeList.name)}` : ""}`
    : filtering
      ? `${contacts.length.toLocaleString()} contact${contacts.length === 1 ? "" : "s"} in ${escapeHtml(activeList?.name || "this list")}`
      : `${contacts.length.toLocaleString()} contact${contacts.length === 1 ? "" : "s"} across ${lists.length.toLocaleString()} list${lists.length === 1 ? "" : "s"}`;

  els.content.innerHTML = `
    <div class="contacts-view">
      <div class="section-lead contacts-lead">
        <div>
          <h2>${searching ? "Search results" : "Audience"}</h2>
          <p>${subtitle}</p>
        </div>
        ${canManage ? `<div class="section-actions"><button class="button" id="import-contacts">Import CSV</button><button class="button primary" id="add-contact">Add contact</button></div>` : ""}
      </div>

      <div class="contacts-meta">
        <div class="contacts-stat"><span>Shown</span><strong>${contacts.length.toLocaleString()}</strong></div>
        <div class="contacts-stat"><span>Active</span><strong>${activeCount.toLocaleString()}</strong></div>
        <div class="contacts-stat"><span>Suppressed</span><strong>${suppressedCount.toLocaleString()}</strong></div>
        <div class="contacts-stat contacts-stat-lists"><span>Lists</span><div class="list-chip-row">${listSummary}${lists.length > 6 ? `<span class="list-chip muted">+${lists.length - 6}</span>` : ""}</div></div>
      </div>

      <div class="toolbar contacts-toolbar">
        <div class="search"><input id="contact-search" type="search" placeholder="Search by email or name" value="${escapeHtml(query)}" aria-label="Search contacts" /></div>
        <select id="contact-list-filter" aria-label="Filter by list">${listFilterOptions}</select>
        <div class="toolbar-group">
          ${can("lists.manage") ? `<button class="button small ghost" id="create-list">+ New list</button>` : ""}
        </div>
      </div>

      <section class="panel contacts-panel">
        ${contacts.length ? `<div class="table-wrap"><table class="contacts-table"><thead><tr><th>Contact</th><th>Lists</th><th>Consent</th><th>Status</th><th>Added</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></div>` : emptyMarkup}
      </section>
    </div>`;

  const search = document.querySelector("#contact-search");
  const listFilter = document.querySelector("#contact-list-filter");
  let searchTimer;
  const currentListId = () => listFilter?.value || "";
  const refresh = (nextQuery = search?.value.trim() || "", nextListId = currentListId()) => renderContacts(nextQuery, nextListId);

  search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh(search.value.trim(), currentListId()), 280);
  });
  listFilter?.addEventListener("change", () => refresh(search?.value.trim() || "", currentListId()));
  document.querySelector("#clear-contact-filters")?.addEventListener("click", () => renderContacts("", ""));
  document.querySelector("#add-contact")?.addEventListener("click", () => openContactModal(null, currentListId()));
  document.querySelector("#empty-add-contact")?.addEventListener("click", () => openContactModal(null, currentListId()));
  document.querySelector("#import-contacts")?.addEventListener("click", () => openImportModal(currentListId()));
  document.querySelector("#empty-import-contacts")?.addEventListener("click", () => openImportModal(currentListId()));
  document.querySelector("#create-list")?.addEventListener("click", openListModal);
  els.content.querySelectorAll("[data-contact-view]").forEach((button) => {
    button.addEventListener("click", () => openContactDetail(button.getAttribute("data-contact-view"), currentListId()));
  });
  els.content.querySelectorAll("[data-contact-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const contact = contacts.find((row) => row.id === button.getAttribute("data-contact-edit"));
      if (contact) openContactModal(contact, currentListId());
    });
  });
  els.content.querySelectorAll("[data-contact-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const contact = contacts.find((row) => row.id === button.getAttribute("data-contact-delete"));
      if (!contact) return;
      const label = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email;
      if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
      try {
        await api(`/api/contacts/${contact.id}`, { method: "DELETE" });
        toast("Contact deleted");
        await refresh(query, currentListId());
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });
}


function listOptions(lists, selected = "") {
  return lists.map((list) => `<option value="${escapeHtml(list.id)}" ${list.id === selected ? "selected" : ""}>${escapeHtml(list.name)} (${Number(list.contact_count || 0)})</option>`).join("");
}

async function openContactDetail(contactId, preferredListId = "") {
  if (!contactId) return;
  try {
    const data = await api(`/api/contacts/${contactId}`);
    const contact = data.contact;
    const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Unnamed contact";
    const listNames = String(contact.lists || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const canOpenMessage = can("deliveries.view");
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const suppression = data.suppression;
    const messageRows = messages.map((message) => {
      const subjectCell = canOpenMessage
        ? `<button type="button" class="text-link" data-message-id="${escapeHtml(message.id)}">${escapeHtml(message.subject || "Untitled")}</button>`
        : escapeHtml(message.subject || "Untitled");
      return `<tr>
        <td>${escapeHtml(message.campaign_name || "—")}</td>
        <td>${subjectCell}</td>
        <td>${statusPill(message.status)}</td>
        <td><span class="date-cell">${formatDate(message.created_at)}</span></td>
      </tr>`;
    }).join("");

    openModal(displayName, "Contact", `
      <div class="contact-detail">
        <dl class="message-meta">
          <dt>Email</dt><dd class="email">${escapeHtml(contact.email)}</dd>
          <dt>Status</dt><dd>${statusPill(contact.status)}</dd>
          <dt>Consent</dt><dd>${escapeHtml(titleCase(contact.consent_source))}</dd>
          <dt>Lists</dt><dd>${listNames.length ? listNames.map((name) => escapeHtml(name)).join(", ") : "—"}</dd>
          <dt>Added</dt><dd>${formatDate(contact.created_at)}</dd>
          <dt>Updated</dt><dd>${formatDate(contact.updated_at)}</dd>
        </dl>

        ${suppression
          ? `<div class="notice warning"><span>!</span><div><strong>On the global suppression list.</strong><br>${escapeHtml(titleCase(suppression.reason))} · ${escapeHtml(titleCase(suppression.source))} · ${formatDate(suppression.created_at)}</div></div>`
          : `<div class="notice"><span>i</span><div><strong>Not on the global suppression list.</strong><br>This address is eligible for campaign sends unless contact status is suppressed.</div></div>`}

        <div class="contact-detail-section">
          <h3>Send history</h3>
          ${messages.length
            ? `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Subject</th><th>Status</th><th>Sent</th></tr></thead><tbody>${messageRows}</tbody></table></div>`
            : `<p class="help">No sends recorded for this contact yet.</p>`}
        </div>

        <div class="form-actions">
          <button class="button" data-close-modal>Close</button>
          ${can("contacts.edit") ? `<button class="button" id="contact-detail-edit">Edit</button>` : ""}
        </div>
      </div>`, false);

    if (canOpenMessage) {
      els.modalBody.querySelectorAll("[data-message-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          try {
            await openMessage(button.getAttribute("data-message-id"));
          } catch (error) {
            toast(error.message, "error");
          }
        });
      });
    }
    document.querySelector("#contact-detail-edit")?.addEventListener("click", () => {
      openContactModal(contact, preferredListId);
    });
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openContactModal(contact = null, preferredListId = "") {
  const lists = await getLists();
  const editing = Boolean(contact?.id);
  const selectedListId = Array.isArray(contact?.list_ids) && contact.list_ids.length
    ? contact.list_ids[0]
    : preferredListId || lists[0]?.id || "";
  const filterListId = preferredListId || "";
  openModal(editing ? "Edit contact" : "Add contact", "Audience", `
    <form id="contact-form" class="stack">
      <div class="form-grid"><label>First name<input name="first_name" maxlength="120" value="${escapeHtml(contact?.first_name || "")}" /></label><label>Last name<input name="last_name" maxlength="120" value="${escapeHtml(contact?.last_name || "")}" /></label></div>
      <label>Email address<input name="email" type="email" value="${escapeHtml(contact?.email || "")}" required /></label>
      <label>List<select name="list_id" required>${listOptions(lists, selectedListId)}</select></label>
      ${editing ? `<label>Status<select name="status"><option value="active" ${contact?.status === "active" ? "selected" : ""}>Active</option><option value="suppressed" ${contact?.status === "suppressed" ? "selected" : ""}>Suppressed</option></select></label>` : ""}
      <label>Consent source<input name="consent_source" value="${escapeHtml(contact?.consent_source || "manual_entry")}" maxlength="120" required /><span class="help">Use only permission-based contacts with documented consent.</span></label>
      <p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">${editing ? "Save changes" : "Add contact"}</button></div>
    </form>`, true);
  document.querySelector("#contact-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const path = editing ? `/api/contacts/${contact.id}` : "/api/contacts";
    const method = editing ? "PATCH" : "POST";
    if (!editing) delete data.status;
    await submitForm(form, () => api(path, { method, body: data }), editing ? "Contact updated" : "Contact added");
    if (!form.querySelector(".form-error").textContent) {
      closeModal();
      await renderContacts(document.querySelector("#contact-search")?.value.trim() || "", filterListId);
    }
  });
}

async function openListModal() {
  openModal("Create list", "Audience", `
    <form id="list-form" class="stack"><label>List name<input name="name" required maxlength="120" /></label><label>Description<textarea name="description" maxlength="500" placeholder="What this audience opted in to receive"></textarea></label><p class="form-error" role="alert"></p><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create list</button></div></form>`, true);
  document.querySelector("#list-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await submitForm(form, () => api("/api/lists", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "List created");
    if (!form.querySelector(".form-error").textContent) {
      state.lists = [];
      closeModal();
      await renderContacts();
    }
  });
}

function downloadTextFile(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importIssueLabel(reason) {
  if (reason === "invalid_email") return "Invalid email";
  if (reason === "duplicate_in_file") return "Duplicate in file";
  return reason || "Skipped";
}

async function openImportModal(preferredListId = "") {
  const lists = await getLists();
  openModal("Import contacts", "CSV audience", `
    <form id="import-form" class="stack">
      <div class="notice"><span>i</span><div>The CSV must include an <strong>email</strong> column. Optional fields: <strong>first_name</strong> and <strong>last_name</strong>. Import only permission-based contacts. <button type="button" class="text-link" id="download-sample-csv">Download sample CSV</button></div></div>
      <label>Destination list<select name="list_id" required>${listOptions(lists, preferredListId)}</select></label>
      <label>CSV file<input name="file" type="file" accept=".csv,text/csv" required /></label>
      <p class="form-error" role="alert"></p>
      <div id="import-progress" class="import-progress" hidden>
        <div class="import-progress-label">Importing…</div>
        <div class="progress indeterminate" aria-hidden="true"><span></span></div>
      </div>
      <div id="import-result"></div>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Close</button><button class="button primary" type="submit">Import CSV</button></div>
    </form>`, true);

  document.querySelector("#download-sample-csv")?.addEventListener("click", () => {
    downloadTextFile(
      "sendstack-contacts-sample.csv",
      "email,first_name,last_name\nalex@example.com,Alex,Rivera\njordan@example.com,Jordan,Lee\n",
    );
  });

  document.querySelector("#import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.file.files[0];
    const error = form.querySelector(".form-error");
    const progress = document.querySelector("#import-progress");
    const resultEl = document.querySelector("#import-result");
    const submit = form.querySelector('button[type="submit"]');
    const controls = [form.elements.list_id, form.elements.file, submit].filter(Boolean);
    error.textContent = "";
    resultEl.innerHTML = "";
    if (!file) return;

    controls.forEach((el) => { el.disabled = true; });
    if (progress) progress.hidden = false;

    try {
      const csvText = await file.text();
      const result = await api("/api/contacts/import", { method: "POST", body: { csv_text: csvText, list_id: form.elements.list_id.value } });
      if (progress) progress.hidden = true;
      controls.forEach((el) => { el.disabled = false; });
      const issues = Array.isArray(result.issues) ? result.issues : [];
      const issueRows = issues.map((issue) => `<tr><td>${Number(issue.row) || "—"}</td><td>${escapeHtml(issue.email || "—")}</td><td>${escapeHtml(importIssueLabel(issue.reason))}</td></tr>`).join("");
      const truncatedNote = result.issues_truncated
        ? `<p class="help">Showing the first ${issues.length} skipped rows.</p>`
        : "";
      resultEl.innerHTML = `
        <div class="notice"><span>✓</span><div><strong>${Number(result.imported) || 0} imported, ${Number(result.updated) || 0} updated.</strong><br>${Number(result.duplicates) || 0} duplicates and ${Number(result.invalid) || 0} invalid rows skipped.</div></div>
        ${issues.length ? `
          <div class="import-issues">
            <div class="import-issues-head">
              <strong>Skipped rows</strong>
              <button type="button" class="button small ghost" id="download-import-issues">Download skipped rows</button>
            </div>
            <div class="table-wrap"><table><thead><tr><th>Row</th><th>Email</th><th>Reason</th></tr></thead><tbody>${issueRows}</tbody></table></div>
            ${truncatedNote}
          </div>` : ""}`;
      if (issues.length) {
        document.querySelector("#download-import-issues")?.addEventListener("click", () => {
          const lines = ["row,email,reason", ...issues.map((issue) => {
            const email = String(issue.email || "").replace(/"/g, '""');
            const reason = String(issue.reason || "").replace(/"/g, '""');
            return `${Number(issue.row) || ""},"${email}","${reason}"`;
          })];
          downloadTextFile("sendstack-import-skipped.csv", `${lines.join("\n")}\n`);
        });
      }
      state.lists = [];
      toast("CSV import complete");
      await renderContacts(document.querySelector("#contact-search")?.value.trim() || "", preferredListId || form.elements.list_id.value);
    } catch (requestError) {
      error.textContent = requestError.message;
    } finally {
      controls.forEach((el) => { el.disabled = false; });
      if (progress) progress.hidden = true;
    }
  });
}

async function renderCampaigns() {
  const data = await api("/api/campaigns");
  await getLists();
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${data.campaigns.length} campaign${data.campaigns.length === 1 ? "" : "s"}</h2><p>${can("campaigns.manage") ? (can("campaigns.send") ? "Create, preview, and deliver messages to your selected audience." : "Create and edit drafts, and send previews. An administrator launches delivery.") : "Read-only campaign reporting without recipient-level personal data."}</p></div>${can("campaigns.manage") ? `<button class="button primary" data-new-campaign>New campaign</button>` : ""}</div>
    ${data.campaigns.length ? `<section class="campaign-grid">${data.campaigns.map(renderCampaignCard).join("")}</section>` : `<section class="panel empty-state"><div><div class="empty-mark">✦</div><h2>No campaigns yet</h2><p>${can("campaigns.manage") ? "Create your first message, preview personalization, and prepare it for delivery." : "Campaign reports will appear here after a campaign is created."}</p>${can("campaigns.manage") ? `<button class="button primary" data-new-campaign>New campaign</button>` : ""}</div></section>`}`;
}

function renderCampaignCard(campaign) {
  const recipients = Number(campaign.recipients || 0);
  const sent = Number(campaign.sent || 0);
  const queued = Number(campaign.queued || 0);
  const issues = Number(campaign.failed || 0) + Number(campaign.bounced || 0) + Number(campaign.complained || 0);
  const editable = can("campaigns.manage") && (
    campaign.status === "draft"
    || (campaign.status === "paused" && can("campaigns.send"))
  );
  const launchable = can("campaigns.send") && ["draft", "paused"].includes(campaign.status);
  const canPreview = can("campaigns.manage");
  return `<article class="campaign-card" data-campaign-id="${escapeHtml(campaign.id)}">
    <div class="campaign-card-top"><span class="subtext">${escapeHtml(campaign.list_name)} · ${escapeHtml(titleCase(campaign.content_mode || "custom_html"))}</span>${statusPill(campaign.status)}</div>
    <h3>${escapeHtml(campaign.name)}</h3><p>${escapeHtml(campaign.subject)}</p>
    <div class="campaign-stats"><div><span>Recipients</span><strong>${recipients}</strong></div><div><span>${isLiveDelivery() ? "Sent" : "Captured"}</span><strong>${sent}</strong></div><div><span>Issues</span><strong>${issues}</strong></div></div>
    ${queued ? `<div class="progress" style="margin-bottom:14px"><span style="width:${recipients ? Math.round((sent / recipients) * 100) : 0}%"></span></div>` : ""}
    <div class="campaign-card-actions">
      <button class="button small" data-action="view" data-id="${escapeHtml(campaign.id)}">Details</button>
      ${editable ? `<button class="button small ghost" data-action="edit" data-id="${escapeHtml(campaign.id)}">Edit</button>` : ""}
      ${canPreview ? `<button class="button small ghost" data-action="test" data-id="${escapeHtml(campaign.id)}">Preview</button>` : ""}
      ${can("campaigns.send") && campaign.status === "sending" ? `<button class="button small" data-action="pause" data-id="${escapeHtml(campaign.id)}">Pause</button>` : ""}
      ${launchable ? `<button class="button small primary" data-action="${campaign.status === "paused" ? "resume" : "launch"}" data-id="${escapeHtml(campaign.id)}">${campaign.status === "paused" ? "Resume delivery" : (isLiveDelivery() ? "Start delivery" : "Send in Dev Mode")}</button>` : ""}
    </div>
  </article>`;
}

const contentModes = [
  { id: "visual", icon: "▦", title: "Visual builder", copy: "Fill in brand, headline, and CTA — we build the email.", recommended: true },
  { id: "rich_text", icon: "Aa", title: "Rich text", copy: "Write like a doc. Bold, lists, and links — no HTML." },
  { id: "custom_html", icon: "</>", title: "Custom HTML", copy: "Paste a full template when you need full control." },
  { id: "plain_text", icon: "¶", title: "Plain text", copy: "Text-only for maximum deliverability." },
];

const contentModeHints = {
  visual: "Best for most campaigns. Layout, colors, and unsubscribe are handled for you.",
  rich_text: "Good when the message is mostly prose and you want light formatting.",
  custom_html: "Use when you already have HTML from a designer or another tool.",
  plain_text: "Simplest format. A basic HTML wrapper is still generated for clients that need it.",
};

function contentModePicker(selectedMode) {
  return `<div class="content-mode-section">
    <span class="field-label">How do you want to write this email?</span>
    <div class="content-mode-grid" role="radiogroup" aria-label="Message format">${contentModes.map((mode) => `
      <button class="content-mode-card ${mode.id === selectedMode ? "selected" : ""}" type="button" data-content-mode="${mode.id}" role="radio" aria-checked="${mode.id === selectedMode}">
        <span class="content-mode-icon">${escapeHtml(mode.icon)}</span>
        <span>
          <strong>${escapeHtml(mode.title)}${mode.recommended ? `<em class="content-mode-badge">Recommended</em>` : ""}</strong>
          <small>${escapeHtml(mode.copy)}</small>
        </span>
      </button>`).join("")}</div>
    <p class="help content-mode-hint" id="content-mode-hint">${escapeHtml(contentModeHints[selectedMode] || "")}</p>
  </div>`;
}

function modeEditorMarkup(mode, draft) {
  if (mode === "visual") {
    const data = { ...defaultVisualContent, ...(draft || {}) };
    return `<div class="mode-editor visual-editor" data-mode-editor="visual">
      <div class="form-grid"><label>Layout<select data-visual-field="template"><option value="announcement" ${data.template === "announcement" ? "selected" : ""}>Announcement</option><option value="newsletter" ${data.template === "newsletter" ? "selected" : ""}>Newsletter</option><option value="simple" ${data.template === "simple" ? "selected" : ""}>Simple</option></select></label><label>Accent colour<input data-visual-field="accent_color" type="color" value="${escapeHtml(data.accent_color)}" /></label></div>
      <label>Brand name<input data-visual-field="brand_name" maxlength="80" value="${escapeHtml(data.brand_name)}" /></label>
      <label>Inbox preview text<input data-visual-field="preheader" maxlength="160" value="${escapeHtml(data.preheader)}" /></label>
      <label>Headline<input data-visual-field="headline" maxlength="180" value="${escapeHtml(data.headline)}" /></label>
      <label>Message<textarea data-visual-field="body" rows="7">${escapeHtml(data.body)}</textarea></label>
      <div class="form-grid"><label>Button label<input data-visual-field="cta_label" maxlength="80" value="${escapeHtml(data.cta_label)}" /></label><label>Button link<input data-visual-field="cta_url" type="url" value="${escapeHtml(data.cta_url)}" placeholder="https://" /></label></div>
      <label>Footer note<input data-visual-field="footer" maxlength="240" value="${escapeHtml(data.footer)}" /></label>
      <p class="help">Personalized greeting and unsubscribe link are added automatically.</p>
    </div>`;
  }
  if (mode === "rich_text") {
    const richHtml = sanitizeRichHtml(draft?.rich_html || defaultRichContent);
    return `<div class="mode-editor" data-mode-editor="rich_text"><span class="field-label">Message</span><div class="rich-toolbar" role="toolbar" aria-label="Text formatting"><button type="button" data-rich-command="bold" aria-label="Bold"><strong>B</strong></button><button type="button" data-rich-command="italic" aria-label="Italic"><em>I</em></button><button type="button" data-rich-command="underline" aria-label="Underline"><u>U</u></button><button type="button" data-rich-command="insertUnorderedList" aria-label="Bulleted list">• List</button></div><div id="rich-editor" class="rich-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Rich text message">${richHtml}</div><p class="help">Formatting is limited to email-safe text, headings, links, and lists. Unsubscribe is added automatically.</p></div>`;
  }
  if (mode === "plain_text") {
    return `<div class="mode-editor" data-mode-editor="plain_text"><label>Plain-text message<textarea id="plain-editor" class="plain-editor" rows="15">${escapeHtml(draft?.plain_text || defaultPlainContent)}</textarea><span class="help">Line breaks are preserved. A safe HTML wrapper is generated for clients that require it.</span></label></div>`;
  }
  return `<div class="mode-editor" data-mode-editor="custom_html"><label>HTML message<textarea id="html-editor" class="code-area" rows="16" required>${escapeHtml(draft?.html_body || defaultTemplate)}</textarea><span class="help">Scripts, forms, embedded objects, unsafe URLs, and event handlers are blocked.</span></label><label>Plain-text alternative<textarea id="html-text-fallback" rows="8">${escapeHtml(draft?.text_body || defaultPlainContent)}</textarea></label></div>`;
}

async function openCampaignComposer(campaignId = null) {
  const [lists, campaignData] = await Promise.all([
    getLists(),
    campaignId ? api(`/api/campaigns/${campaignId}`) : Promise.resolve(null),
  ]);
  const campaign = campaignData?.campaign || {};
  let activeCampaignId = campaignId;
  let attachments = Array.isArray(campaign.attachments) ? [...campaign.attachments] : [];
  let pendingFiles = [];
  const storedContent = safeContentObject(campaign.content_json);
  let selectedMode = contentModes.some((mode) => mode.id === campaign.content_mode) ? campaign.content_mode : (campaignId ? "custom_html" : "visual");
  const modeDrafts = {
    visual: selectedMode === "visual" ? { ...defaultVisualContent, ...storedContent } : { ...defaultVisualContent },
    rich_text: selectedMode === "rich_text" ? { schema_version: 1, rich_html: storedContent.rich_html || defaultRichContent } : { schema_version: 1, rich_html: defaultRichContent },
    custom_html: { schema_version: 1, html_body: campaign.html_body || defaultTemplate, text_body: campaign.text_body || defaultPlainContent },
    plain_text: selectedMode === "plain_text" ? { schema_version: 1, plain_text: storedContent.plain_text || campaign.text_body || defaultPlainContent } : { schema_version: 1, plain_text: defaultPlainContent },
  };
  const defaultFromName = campaign.from_name || state.session?.user?.name || "CTN";
  const defaultCampaignName = campaign.name || (campaignId ? "" : "Untitled campaign");
  const totalAttachmentCount = () => attachments.length + pendingFiles.length;
  const totalAttachmentBytes = () => (
    attachments.reduce((sum, file) => sum + Number(file.byte_size || 0), 0)
    + pendingFiles.reduce((sum, file) => sum + Number(file.size || 0), 0)
  );
  openModal(campaignId ? "Edit campaign" : "New campaign", "Composer", `
    <form id="campaign-form" class="composer">
      <div class="composer-fields">
        <label>Internal campaign name<input name="name" maxlength="160" value="${escapeHtml(defaultCampaignName)}" placeholder="Untitled campaign" required /></label>
        <label>Audience<select name="list_id" required>${listOptions(lists, campaign.list_id || lists[0]?.id)}</select><span class="help">Suppression is checked again immediately before delivery.</span></label>
        <div class="form-grid"><label>From name<input name="from_name" value="${escapeHtml(defaultFromName)}" placeholder="Name the receiver will see" required /></label><label>From email<input name="from_email" type="email" value="${escapeHtml(campaign.from_email || "noreply@ctn-sk.com")}" required /></label></div>
        <label>Subject<input name="subject" maxlength="250" value="${escapeHtml(campaign.subject || "An update from CTN")}" required /></label>
        ${contentModePicker(selectedMode)}
        <div id="mode-editor-host">${modeEditorMarkup(selectedMode, modeDrafts[selectedMode])}</div>
        <p class="help variable-help">Personalization: {{first_name}}, {{last_name}}, {{email}}, {{unsubscribe_url}}</p>
        <section class="attachment-panel" id="attachment-panel">
          <div class="attachment-panel-head">
            <div><strong>Attachments</strong></div>
            <div id="attachment-meter">${attachmentMeterMarkup(totalAttachmentCount(), totalAttachmentBytes())}</div>
          </div>
          <div class="attachment-dropzone" id="attachment-dropzone" tabindex="0" aria-label="Attachment drop zone">
            <div id="attachment-list">${activeCampaignId ? attachmentListMarkup(attachments, { editable: true }) : pendingAttachmentListMarkup(pendingFiles)}</div>
            <label class="attachment-upload button small">Add files<input id="attachment-input" type="file" accept="${ATTACHMENT_ACCEPT}" multiple ${totalAttachmentCount() >= ATTACHMENT_MAX_COUNT ? "disabled" : ""} /></label>
          </div>
          <p class="form-error" id="attachment-error" role="alert"></p>
        </section>
        <p class="form-error" data-form-error role="alert"></p>
        <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">${campaignId ? "Save changes" : "Save draft"}</button></div>
      </div>
      <div class="preview-shell"><div class="preview-bar"><span>PERSONALIZED PREVIEW</span><div class="preview-dots"><span></span><span></span><span></span></div></div><iframe class="email-preview" title="Email preview" sandbox=""></iframe></div>
    </form>`, false);
  const form = document.querySelector("#campaign-form");
  const editorHost = form.querySelector("#mode-editor-host");
  const captureModeDraft = () => {
    if (selectedMode === "visual") {
      const visual = { schema_version: 1 };
      form.querySelectorAll("[data-visual-field]").forEach((field) => { visual[field.dataset.visualField] = field.value; });
      modeDrafts.visual = visual;
    } else if (selectedMode === "rich_text") {
      modeDrafts.rich_text = { schema_version: 1, rich_html: sanitizeRichHtml(form.querySelector("#rich-editor")?.innerHTML || "") };
    } else if (selectedMode === "plain_text") {
      modeDrafts.plain_text = { schema_version: 1, plain_text: form.querySelector("#plain-editor")?.value || "" };
    } else {
      modeDrafts.custom_html = { schema_version: 1, html_body: form.querySelector("#html-editor")?.value || "", text_body: form.querySelector("#html-text-fallback")?.value || "" };
    }
  };
  const updatePreview = () => {
    captureModeDraft();
    const substitutions = {
      "{{first_name}}": "Alex",
      "{{last_name}}": "Morgan",
      "{{email}}": "alex@example.test",
      "{{unsubscribe_url}}": "#unsubscribe",
    };
    let markup = buildCampaignContent(selectedMode, modeDrafts[selectedMode]).html_body;
    Object.entries(substitutions).forEach(([key, value]) => { markup = markup.split(key).join(value); });
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
    form.querySelector("iframe").srcdoc = policy + markup;
  };
  const attachEditorEvents = () => {
    editorHost.querySelectorAll("input, select, textarea, [contenteditable]").forEach((field) => field.addEventListener("input", updatePreview));
    const richEditor = editorHost.querySelector("#rich-editor");
    richEditor?.addEventListener("paste", (event) => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    });
    editorHost.querySelectorAll("[data-rich-command]").forEach((button) => button.addEventListener("click", () => {
      richEditor?.focus();
      document.execCommand(button.dataset.richCommand, false);
      updatePreview();
    }));
  };
  form.querySelectorAll("[data-content-mode]").forEach((button) => button.addEventListener("click", () => {
    captureModeDraft();
    selectedMode = button.dataset.contentMode;
    form.querySelectorAll("[data-content-mode]").forEach((item) => {
      const active = item.dataset.contentMode === selectedMode;
      item.classList.toggle("selected", active);
      item.setAttribute("aria-checked", String(active));
    });
    const hint = form.querySelector("#content-mode-hint");
    if (hint) hint.textContent = contentModeHints[selectedMode] || "";
    editorHost.innerHTML = modeEditorMarkup(selectedMode, modeDrafts[selectedMode]);
    attachEditorEvents();
    updatePreview();
  }));
  attachEditorEvents();
  updatePreview();
  const refreshAttachmentUi = () => {
    const listHost = form.querySelector("#attachment-list");
    const meterHost = form.querySelector("#attachment-meter");
    const input = form.querySelector("#attachment-input");
    const dropzone = form.querySelector("#attachment-dropzone");
    if (listHost) {
      listHost.innerHTML = activeCampaignId
        ? attachmentListMarkup(attachments, { editable: true })
        : pendingAttachmentListMarkup(pendingFiles);
    }
    if (meterHost) meterHost.innerHTML = attachmentMeterMarkup(totalAttachmentCount(), totalAttachmentBytes());
    if (input) input.disabled = totalAttachmentCount() >= ATTACHMENT_MAX_COUNT;
    dropzone?.classList.toggle("is-full", totalAttachmentCount() >= ATTACHMENT_MAX_COUNT);
  };
  const queueOrUploadFiles = async (fileList) => {
    const errorEl = form.querySelector("#attachment-error");
    if (errorEl) errorEl.textContent = "";
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const file of files) {
      if (file.size > ATTACHMENT_MAX_FILE_BYTES) {
        if (errorEl) errorEl.textContent = `"${file.name}" is larger than 5 MB.`;
        return;
      }
      if (totalAttachmentCount() >= ATTACHMENT_MAX_COUNT) {
        if (errorEl) errorEl.textContent = "A campaign can have at most 3 attachments.";
        return;
      }
      if (totalAttachmentBytes() + file.size > ATTACHMENT_MAX_TOTAL_BYTES) {
        if (errorEl) errorEl.textContent = "Attachments for one campaign cannot exceed 10 MB total.";
        return;
      }
      if (!activeCampaignId) {
        pendingFiles.push(file);
        continue;
      }
      try {
        const body = new FormData();
        body.append("file", file);
        const result = await api(`/api/campaigns/${activeCampaignId}/attachments`, { method: "POST", body });
        attachments = result.attachments || [];
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message;
        else toast(error.message, "error");
        refreshAttachmentUi();
        return;
      }
    }
    refreshAttachmentUi();
    if (!activeCampaignId) toast(files.length === 1 ? "Attachment queued — uploads on save" : `${files.length} attachments queued — upload on save`);
    else toast(files.length === 1 ? "Attachment added" : `${files.length} attachments added`);
  };
  const uploadPendingFiles = async (campaignIdForUpload) => {
    const errorEl = form.querySelector("#attachment-error");
    if (errorEl) errorEl.textContent = "";
    const queued = [...pendingFiles];
    pendingFiles = [];
    for (let index = 0; index < queued.length; index += 1) {
      const file = queued[index];
      try {
        const body = new FormData();
        body.append("file", file);
        const result = await api(`/api/campaigns/${campaignIdForUpload}/attachments`, { method: "POST", body });
        attachments = result.attachments || [];
      } catch (error) {
        pendingFiles = queued.slice(index);
        if (errorEl) errorEl.textContent = error.message;
        else toast(error.message, "error");
        refreshAttachmentUi();
        return false;
      }
    }
    refreshAttachmentUi();
    return true;
  };
  const bindAttachmentControls = () => {
    const input = form.querySelector("#attachment-input");
    const dropzone = form.querySelector("#attachment-dropzone");
    input?.addEventListener("change", async () => {
      const files = input.files;
      input.value = "";
      await queueOrUploadFiles(files);
    });
    if (dropzone) {
      ["dragenter", "dragover"].forEach((type) => {
        dropzone.addEventListener(type, (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (totalAttachmentCount() < ATTACHMENT_MAX_COUNT) dropzone.classList.add("is-dragover");
        });
      });
      ["dragleave", "drop"].forEach((type) => {
        dropzone.addEventListener(type, (event) => {
          event.preventDefault();
          event.stopPropagation();
          dropzone.classList.remove("is-dragover");
        });
      });
      dropzone.addEventListener("drop", async (event) => {
        await queueOrUploadFiles(event.dataTransfer?.files);
      });
    }
    form.querySelector("#attachment-list")?.addEventListener("click", async (event) => {
      const pendingButton = event.target.closest("[data-remove-pending]");
      if (pendingButton) {
        const index = Number(pendingButton.dataset.removePending);
        if (Number.isInteger(index)) {
          pendingFiles.splice(index, 1);
          refreshAttachmentUi();
          toast("Attachment removed");
        }
        return;
      }
      const button = event.target.closest("[data-remove-attachment]");
      if (!button || !activeCampaignId) return;
      try {
        const result = await api(`/api/campaigns/${activeCampaignId}/attachments/${button.dataset.removeAttachment}`, { method: "DELETE", body: {} });
        attachments = result.attachments || [];
        refreshAttachmentUi();
        toast("Attachment removed");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  };
  bindAttachmentControls();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    captureModeDraft();
    const content = buildCampaignContent(selectedMode, modeDrafts[selectedMode]);
    const payload = Object.fromEntries(new FormData(form));
    delete payload.file;
    payload.content_mode = selectedMode;
    payload.content_json = content.content_json;
    payload.html_body = content.html_body;
    payload.text_body = content.text_body;
    const creating = !activeCampaignId;
    const path = activeCampaignId ? `/api/campaigns/${activeCampaignId}` : "/api/campaigns";
    const method = activeCampaignId ? "PATCH" : "POST";
    const result = await submitForm(form, () => api(path, { method, body: payload }), creating ? "Draft saved" : "Campaign updated");
    const formError = form.querySelector("[data-form-error]");
    if (formError?.textContent) return;
    if (creating && result?.campaign?.id) {
      activeCampaignId = result.campaign.id;
      const uploaded = await uploadPendingFiles(activeCampaignId);
      if (!uploaded) {
        const submitBtn = form.querySelector("button[type=submit]");
        if (submitBtn) submitBtn.textContent = "Save changes";
        refreshAttachmentUi();
        return;
      }
    }
    closeModal();
    if (state.currentView === "campaigns") await renderCampaigns();
    else await navigate("campaigns");
  });
}

async function openCampaignDetails(campaignId) {
  const { campaign } = await api(`/api/campaigns/${campaignId}`);
  const stats = campaign.stats || {};
  const total = Object.values(stats).reduce((sum, value) => sum + Number(value || 0), 0);
  const sentLabel = isLiveDelivery() ? "Sent / submitted" : "Captured";
  openModal(campaign.name, "Campaign detail", `
    <div class="stack">
      <div class="notice"><span>i</span><div><strong>${escapeHtml(campaign.subject)}</strong><br>${escapeHtml(campaign.list_name)} · ${escapeHtml(campaign.from_name)} &lt;${escapeHtml(campaign.from_email)}&gt;</div></div>
      <div class="form-grid">
        <section class="panel"><div class="panel-head"><h3>Delivery totals</h3>${statusPill(campaign.status)}</div><div class="panel-body">
          <div class="metric-line"><span>Audience snapshot</span><strong>${total}</strong></div>
          <div class="metric-line"><span>${sentLabel}</span><strong>${Number(stats.sent || 0)}</strong></div>
          <div class="metric-line"><span>Queued</span><strong>${Number(stats.queued || 0) + Number(stats.processing || 0)}</strong></div>
          <div class="metric-line"><span>Suppressed</span><strong>${Number(stats.suppressed || 0)}</strong></div>
          <div class="metric-line"><span>Failed / bounced / complained</span><strong>${Number(stats.failed || 0) + Number(stats.bounced || 0) + Number(stats.complained || 0)}</strong></div>
        </div></section>
        <section class="panel"><div class="panel-head"><h3>Timing</h3></div><div class="panel-body"><div class="metric-line"><span>Created</span><strong>${formatDate(campaign.created_at)}</strong></div><div class="metric-line"><span>Launched</span><strong>${formatDate(campaign.launched_at)}</strong></div><div class="metric-line"><span>Completed</span><strong>${formatDate(campaign.completed_at)}</strong></div></div></section>
      </div>
      <section class="panel">
        <div class="panel-head"><h3>Attachments</h3></div>
        <div class="panel-body">${attachmentListMarkup(campaign.attachments || [], { editable: false })}</div>
      </section>
      <div class="form-actions"><button class="button" data-close-modal>Close</button>${can("deliveries.view") ? `<button class="button primary" id="view-campaign-deliveries">View deliveries</button>` : ""}</div>
    </div>`, false);
  document.querySelector("#view-campaign-deliveries")?.addEventListener("click", () => {
    closeModal();
    state.deliveryFilters.campaignId = campaignId;
    navigate("deliveries");
  });
}

async function openTestSend(campaignId) {
  const { campaign } = await api(`/api/campaigns/${campaignId}`);
  const live = isLiveDelivery();
  const defaultEmail = live
    ? (state.session?.user?.email || "")
    : (state.session?.user?.email || "owner@example.test");
  const noticeClass = live ? "notice warning" : "notice";
  const submitLabel = live ? "Send live preview" : "Capture preview";
  openModal("Send a preview", "Before you send", `
    <form id="test-send-form" class="stack">
      <div class="${noticeClass}"><span>${live ? "!" : "i"}</span><div><strong>${escapeHtml(testSendNotice())}</strong></div></div>
      <div class="metric-line"><span>Campaign</span><strong>${escapeHtml(campaign.name)}</strong></div>
      <div class="metric-line"><span>Subject</span><strong>${escapeHtml(campaign.subject)}</strong></div>
      <div class="metric-line"><span>Status</span><strong>${escapeHtml(deliveryStatusLabel())}</strong></div>
      <label>Preview recipient<input name="email" type="email" value="${escapeHtml(defaultEmail)}" placeholder="name@example.com" required autocomplete="email" /></label>
      ${live ? `<label class="confirm-ack"><input type="checkbox" name="ack_live" required /><span>I understand this sends a real email to the address above.</span></label>` : `<p class="help">Result appears in Deliveries as Captured — nothing is mailed externally.</p>`}
      <p class="form-error" role="alert"></p>
      <div class="form-actions">
        <button type="button" class="button" data-close-modal>Cancel</button>
        <button class="button ${live ? "danger" : "primary"}" type="submit">${escapeHtml(submitLabel)}</button>
      </div>
    </form>`, true);
  const form = document.querySelector("#test-send-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = String(form.elements.email.value || "").trim();
    const result = await submitForm(
      form,
      () => api(`/api/campaigns/${campaignId}/test-send`, { method: "POST", body: { email } }),
      testSendSuccessMessage(email),
    );
    if (!result) return;
    closeModal();
    state.deliveryFilters.campaignId = campaignId;
    navigate("deliveries");
  });
}

async function openLaunchConfirm(campaignId) {
  const { campaign } = await api(`/api/campaigns/${campaignId}`);
  const copy = launchConfirmCopy();
  const live = isLiveDelivery();
  const eligible = Number(campaign.eligible_recipients || 0);
  const noticeClass = live ? "notice warning" : "notice";
  const setupHelp = can("sending.view") && !live
    ? `<p class="help">Turn on live delivery in Sending setup when you are ready for real recipients.</p>`
    : "";
  const emptyWarn = eligible === 0
    ? `<div class="notice warning"><span>!</span><div>No eligible recipients on this list (active and not suppressed). Launch will complete with nothing sent.</div></div>`
    : "";
  openModal(copy.title, "Confirm delivery", `
    <div class="stack" id="launch-confirm">
      <div class="${noticeClass}"><span>!</span><div><strong>${escapeHtml(copy.notice)}</strong><br>${escapeHtml(copy.outcome)}</div></div>
      ${emptyWarn}
      <div class="metric-line"><span>Campaign</span><strong>${escapeHtml(campaign.name)}</strong></div>
      <div class="metric-line"><span>Subject</span><strong>${escapeHtml(campaign.subject)}</strong></div>
      <div class="metric-line"><span>Audience</span><strong>${escapeHtml(campaign.list_name)}</strong></div>
      <div class="metric-line"><span>Eligible now</span><strong>${eligible.toLocaleString()}</strong></div>
      <div class="metric-line"><span>Status</span><strong>${escapeHtml(deliveryStatusLabel())}</strong></div>
      <div class="metric-line"><span>Daily send limit</span><strong>${Number(state.session.daily_limit).toLocaleString()}</strong></div>
      ${setupHelp}
      ${live ? `<label class="confirm-ack"><input type="checkbox" id="launch-ack" /><span>I understand this will email up to ${eligible.toLocaleString()} real recipient${eligible === 1 ? "" : "s"}.</span></label>` : ""}
      <p class="form-error" id="launch-error" role="alert"></p>
      <div class="form-actions">
        <button class="button" data-close-modal type="button">Cancel</button>
        <button class="button ${live ? "danger" : "primary"}" id="confirm-launch" ${live ? "disabled" : ""}>${escapeHtml(copy.confirm)}</button>
      </div>
    </div>`, true);
  const ack = document.querySelector("#launch-ack");
  const confirmBtn = document.querySelector("#confirm-launch");
  const errorEl = document.querySelector("#launch-error");
  ack?.addEventListener("change", () => {
    confirmBtn.disabled = !ack.checked;
  });
  confirmBtn.addEventListener("click", async () => {
    if (live && !ack?.checked) return;
    confirmBtn.disabled = true;
    if (errorEl) errorEl.textContent = "";
    try {
      const result = await api(`/api/campaigns/${campaignId}/launch`, { method: "POST", body: {} });
      closeModal();
      toast(launchOutcomeMessage(result));
      state.deliveryFilters.campaignId = campaignId;
      if (state.currentView === "campaigns") await renderCampaigns();
      else await navigate("campaigns");
    } catch (error) {
      if (errorEl) errorEl.textContent = error.message;
      else toast(error.message, "error");
      confirmBtn.disabled = live ? !ack?.checked : false;
    }
  });
}

async function campaignAction(action, id) {
  if (action === "view") return openCampaignDetails(id);
  if (action === "edit") return openCampaignComposer(id);
  if (action === "test") return openTestSend(id);
  if (action === "launch") return openLaunchConfirm(id);
  if (action === "resume") {
    openModal("Resume delivery?", "Confirm", `
      <div class="stack">
        <div class="notice"><span>i</span><div>Delivery will continue for remaining eligible recipients under <strong>${escapeHtml(deliveryStatusLabel())}</strong>.</div></div>
        <div class="form-actions">
          <button class="button" data-close-modal type="button">Cancel</button>
          <button class="button primary" id="confirm-resume">Resume delivery</button>
        </div>
      </div>`, true);
    document.querySelector("#confirm-resume").addEventListener("click", async () => {
      closeModal();
      await executeCampaignAction("resume", id);
    });
    return;
  }
  return executeCampaignAction(action, id);
}

async function executeCampaignAction(action, id) {
  try {
    const result = await api(`/api/campaigns/${id}/${action}`, { method: "POST", body: {} });
    if (action === "launch") toast(launchOutcomeMessage(result));
    else if (action === "pause") toast("Delivery paused");
    else if (action === "resume") toast("Delivery resumed");
    else toast(`Campaign ${action}d`);
    await renderCampaigns();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renderDeliveries() {
  const filters = state.deliveryFilters;
  const params = new URLSearchParams();
  if (filters.campaignId) params.set("campaign_id", filters.campaignId);
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const queryString = params.toString();
  const data = await api(`/api/messages${queryString ? `?${queryString}` : ""}`);
  const live = isLiveDelivery();
  const count = data.messages.length;
  const filtering = Boolean(filters.campaignId || filters.q || filters.status || filters.from || filters.to);
  const statusOptions = [
    ["", "All statuses"],
    ["captured", "Captured"],
    ["submitted", "Submitted"],
    ["delivered", "Delivered"],
    ["failed", "Failed"],
    ["bounced", "Bounced"],
    ["complained", "Complained"],
    ["unsubscribed", "Unsubscribed"],
    ["suppressed", "Suppressed"],
  ].map(([value, label]) => `<option value="${value}" ${filters.status === value ? "selected" : ""}>${label}</option>`).join("");
  const heading = filtering
    ? `${count.toLocaleString()} match${count === 1 ? "" : "es"}`
    : live
      ? `${count.toLocaleString()} deliver${count === 1 ? "y" : "ies"}`
      : `${count.toLocaleString()} captured message${count === 1 ? "" : "s"}`;
  const lead = live
    ? "Review outbound results, open rendered content, and check delivery status."
    : "Inspect rendered content captured in this workspace. No email leaves the app in Dev Mode.";
  const emptyCopy = filtering
    ? "Nothing matches these filters. Try clearing search, status, or date range."
    : live
      ? "Send a campaign or preview to see delivery records here."
      : "Create a campaign and send a preview to inspect the rendered result in this workspace.";
  const filterBits = [];
  if (filters.campaignId) filterBits.push(live ? "campaign deliveries" : "campaign messages");
  if (filters.q) filterBits.push(`“${escapeHtml(filters.q)}”`);
  if (filters.status) filterBits.push(filters.status === "captured" ? "Captured" : titleCase(filters.status));
  if (filters.from || filters.to) {
    filterBits.push([filters.from || "…", filters.to || "…"].join(" → "));
  }
  const filterNote = filterBits.length
    ? `<p class="delivery-filter-note">Filtered by ${filterBits.join(" · ")}.</p>`
    : "";
  const emptyMarkup = filtering
    ? `<div class="empty-state"><div><div class="empty-mark">⌕</div><h2>No matching deliveries</h2><p>${emptyCopy}</p><button class="button" id="clear-delivery-filters">Clear filters</button></div></div>`
    : `<div class="empty-state"><div><div class="empty-mark">↗</div><h2>No deliveries yet</h2><p>${emptyCopy}</p><button class="button primary" data-new-campaign>Create campaign</button></div></div>`;

  const tableRows = data.messages.map((message) => `<tr>
      <td class="delivery-recipient"><strong class="email">${escapeHtml(message.to_email)}</strong></td>
      <td class="delivery-message"><strong>${escapeHtml(message.subject)}</strong><span class="subtext">${escapeHtml(message.from_email)}</span></td>
      <td class="delivery-campaign">${escapeHtml(message.campaign_name || "Test send")}</td>
      <td class="delivery-status">${statusPill(message.status)}</td>
      <td class="delivery-time"><span class="date-cell">${formatDate(message.created_at)}</span></td>
      <td class="table-actions"><button class="button small ghost" data-message-id="${escapeHtml(message.id)}">View</button></td>
    </tr>`).join("");

  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${heading}</h2><p>${lead}</p></div><div class="section-actions">${filtering ? `<button class="button" id="clear-delivery-filters">Clear filters</button>` : ""}</div></div>
    ${deliveryStatusLegend(live)}
    ${filterNote}
    <div class="toolbar deliveries-toolbar">
      <div class="search"><input id="delivery-search" type="search" placeholder="Search recipient, subject, or campaign" value="${escapeHtml(filters.q)}" aria-label="Search deliveries" /></div>
      <select id="delivery-status-filter" aria-label="Filter by status">${statusOptions}</select>
      <label class="delivery-date"><span>From</span><input id="delivery-from" type="date" value="${escapeHtml(filters.from)}" aria-label="From date" /></label>
      <label class="delivery-date"><span>To</span><input id="delivery-to" type="date" value="${escapeHtml(filters.to)}" aria-label="To date" /></label>
    </div>
    <section class="panel deliveries-panel">${data.messages.length ? `<div class="table-wrap"><table class="deliveries-table"><thead><tr><th>Recipient</th><th>Message</th><th>Campaign</th><th>Status</th><th>Time</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></div>` : emptyMarkup}</section>`;

  const search = document.querySelector("#delivery-search");
  const statusFilter = document.querySelector("#delivery-status-filter");
  const fromInput = document.querySelector("#delivery-from");
  const toInput = document.querySelector("#delivery-to");
  let searchTimer;

  const applyFilters = (next = {}) => {
    state.deliveryFilters = {
      ...state.deliveryFilters,
      ...next,
    };
    if ("q" in next) state.deliveryFilters._focusSearch = true;
    renderDeliveries();
  };
  const clearFilters = () => {
    state.deliveryFilters = { campaignId: null, q: "", status: "", from: "", to: "" };
    renderDeliveries();
  };

  search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applyFilters({ q: search.value.trim() }), 280);
  });
  statusFilter?.addEventListener("change", () => applyFilters({ status: statusFilter.value || "" }));
  fromInput?.addEventListener("change", () => {
    const from = fromInput.value || "";
    if (from && filters.to && from > filters.to) {
      toast("Start date must be on or before end date.", "error");
      fromInput.value = filters.from;
      return;
    }
    applyFilters({ from });
  });
  toInput?.addEventListener("change", () => {
    const to = toInput.value || "";
    if (filters.from && to && filters.from > to) {
      toast("End date must be on or after start date.", "error");
      toInput.value = filters.to;
      return;
    }
    applyFilters({ to });
  });
  document.querySelectorAll("#clear-delivery-filters").forEach((button) => {
    button.addEventListener("click", clearFilters);
  });

  if (state.deliveryFilters._focusSearch) {
    delete state.deliveryFilters._focusSearch;
    search?.focus();
    const len = search?.value.length || 0;
    search?.setSelectionRange(len, len);
  }
}

async function openMessage(messageId) {
  const { message } = await api(`/api/messages/${messageId}`);
  openModal(message.subject, "Message", `
    <dl class="message-meta"><dt>To</dt><dd>${escapeHtml(message.to_email)}</dd><dt>From</dt><dd>${escapeHtml(message.from_email)}</dd><dt>Status</dt><dd>${statusPill(message.status)}${deliveryStatusMeaning(message.status) ? `<span class="status-hint">${escapeHtml(deliveryStatusMeaning(message.status))}</span>` : ""}</dd><dt>${isLiveDelivery() ? "Sent" : "Captured"}</dt><dd>${formatDate(message.created_at)}</dd></dl>
    <div class="message-preview"><iframe title="Message preview" sandbox=""></iframe></div>
    <div class="form-actions" style="margin-top:16px"><button class="button" data-close-modal>Close</button>${can("deliveries.feedback") ? `<a class="button" href="/u/${encodeURIComponent(message.unsubscribe_token)}" target="_blank" rel="noopener">Test unsubscribe</a><button class="button danger" data-feedback="hard_bounce">Simulate hard bounce</button><button class="button danger" data-feedback="complaint">Simulate complaint</button>` : ""}</div>`, false);
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
  document.querySelector(".message-preview iframe").srcdoc = policy + message.html_body;
  document.querySelectorAll("[data-feedback]").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm(`Mark this recipient as a ${titleCase(button.dataset.feedback)} and suppress it globally?`)) return;
    try {
      await api(`/api/messages/${messageId}/event`, { method: "POST", body: { event: button.dataset.feedback } });
      toast("Feedback recorded and recipient suppressed");
      closeModal();
      renderDeliveries();
    } catch (error) { toast(error.message, "error"); }
  }));
}

async function renderSuppressions() {
  const data = await api("/api/suppressions");
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${data.suppressions.length} globally suppressed</h2><p>These addresses are excluded from every campaign at execution time.</p></div>${can("suppressions.manage") ? `<button class="button primary" id="add-suppression">Add suppression</button>` : ""}</div>
    <section class="panel">${data.suppressions.length ? `<div class="table-wrap"><table><thead><tr><th>Email</th><th>Reason</th><th>Source</th><th>Created</th></tr></thead><tbody>${data.suppressions.map((entry) => `<tr><td><strong class="email">${escapeHtml(entry.email)}</strong></td><td>${statusPill(entry.reason)}</td><td>${escapeHtml(titleCase(entry.source))}</td><td>${formatDate(entry.created_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><div><div class="empty-mark">⊘</div><h2>No suppressions yet</h2><p>Unsubscribes, hard bounces, complaints, and manual exclusions appear here.</p></div></div>`}</section>`;
  document.querySelector("#add-suppression")?.addEventListener("click", openSuppressionModal);
}

function openSuppressionModal() {
  openModal("Suppress an address", "Safety control", `<form id="suppression-form" class="stack"><div class="notice warning"><span>!</span><div>This creates a manual exclusion. Unsubscribes, bounces, and complaints must come from recipient or verified delivery events.</div></div><label>Email address<input name="email" type="email" required /></label><input name="reason" type="hidden" value="manual" /><p class="form-error" role="alert"></p><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button danger" type="submit">Suppress globally</button></div></form>`, true);
  const form = document.querySelector("#suppression-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitForm(form, () => api("/api/suppressions", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "Address suppressed");
    if (!form.querySelector(".form-error").textContent) { closeModal(); renderSuppressions(); }
  });
}

function roleOptions(roles, selected = "marketer") {
  return roles.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === selected ? "selected" : ""}>${escapeHtml(role.label)}</option>`).join("");
}

function rolePill(role) {
  const safeRole = String(role.role || role.id || "unknown").toLowerCase();
  const label = role.role_label || role.label || titleCase(safeRole);
  return `<span class="role-pill ${escapeHtml(safeRole)}">${escapeHtml(label)}</span>`;
}

async function renderUsers() {
  const data = await api("/api/users");
  state.users = data.users;
  state.roles = data.roles;
  state.permissionDefinitions = data.permissions;
  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${data.users.length} user${data.users.length === 1 ? "" : "s"}</h2><p>Create accounts, assign least-privilege access, and disable access without deleting audit history.</p></div><button class="button primary" id="create-user">Create user</button></div>
    <section class="panel user-directory">
      <div class="panel-head"><div><h2>User directory</h2><p>Role and status changes take effect immediately</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Created</th><th></th></tr></thead><tbody>${data.users.map((user) => `<tr>
        <td><div class="table-user"><span class="avatar">${escapeHtml(initials(user.name))}</span><div><strong>${escapeHtml(user.name)}${user.is_current_user ? `<span class="you-badge">You</span>` : ""}</strong><span class="subtext email">${escapeHtml(user.email)}</span></div></div></td>
        <td>${rolePill(user)}</td><td>${statusPill(user.active ? "active" : "disabled")}</td><td>${user.last_login_at ? formatDate(user.last_login_at) : "Never"}</td><td>${formatDate(user.created_at)}</td><td><button class="button small ghost" data-user-id="${escapeHtml(user.id)}">Manage</button></td>
      </tr>`).join("")}</tbody></table></div>
    </section>

    <section class="role-grid" aria-label="Built-in roles">${data.roles.map((role) => `<article class="role-card ${escapeHtml(role.id)}"><div class="role-card-head"><span class="role-symbol">${role.id === "admin" ? "A" : role.id === "marketer" ? "M" : "R"}</span>${rolePill(role)}</div><h3>${escapeHtml(role.label)}</h3><p>${escapeHtml(role.description)}</p><span class="role-count">${role.permissions.length} permissions</span></article>`).join("")}</section>

    <section class="panel permission-panel">
      <div class="panel-head"><div><h2>Built-in permissions</h2><p>Roles are fixed for this release; every permission is enforced by the server</p></div></div>
      <div class="table-wrap"><table class="permission-table"><thead><tr><th>Capability</th>${data.roles.map((role) => `<th>${escapeHtml(role.label)}</th>`).join("")}</tr></thead><tbody>${data.permissions.map((permission) => `<tr><td><strong>${escapeHtml(permission.label)}</strong><span class="subtext">${escapeHtml(permission.description)}</span></td>${data.roles.map((role) => `<td><span class="permission-check ${role.permissions.includes(permission.id) ? "granted" : "denied"}" aria-label="${role.permissions.includes(permission.id) ? "Granted" : "Not granted"}">${role.permissions.includes(permission.id) ? "✓" : "—"}</span></td>`).join("")}</tr>`).join("")}</tbody></table></div>
    </section>`;
  document.querySelector("#create-user")?.addEventListener("click", openCreateUserModal);
}

function openCreateUserModal() {
  openModal("Create user", "Access control", `
    <form id="create-user-form" class="stack" autocomplete="off">
      <div class="notice"><span>i</span><div>Create the account directly and share the temporary password through a secure channel.</div></div>
      <label>Full name<input name="name" maxlength="120" autocomplete="off" required /></label>
      <label>Email address<input name="email" type="email" autocomplete="off" required /></label>
      <label>Role<select name="role">${roleOptions(state.roles)}</select><span class="help">Choose the least access needed. Roles can be changed later by an administrator.</span></label>
      <label>Temporary password<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required /><span class="help">Use at least 12 characters.</span></label>
      <p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Create user</button></div>
    </form>`, true);
  const form = document.querySelector("#create-user-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await submitForm(form, () => api("/api/users", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "User created");
    if (result) {
      closeModal();
      await renderUsers();
    }
  });
}

function openManageUserModal(userId) {
  const user = state.users.find((entry) => entry.id === userId);
  if (!user) return;
  const selfLocked = user.is_current_user;
  openModal(`Manage ${user.name}`, "Access control", `
    <div class="stack">
      ${selfLocked ? `<div class="notice"><span>i</span><div><strong>This is your account.</strong> Another administrator must change your role or disable your access.</div></div>` : `<div class="notice warning"><span>!</span><div>Role or status changes revoke this user’s active sessions. Disabled users keep their audit history.</div></div>`}
      <form id="user-access-form" class="stack">
        <label>Full name<input name="name" maxlength="120" value="${escapeHtml(user.name)}" required /></label>
        <label>Email address<input name="email" type="email" value="${escapeHtml(user.email)}" required /></label>
        <div class="form-grid"><label>Role<select name="role" ${selfLocked ? "disabled" : ""}>${roleOptions(state.roles, user.role)}</select></label><label>Account status<select name="active" ${selfLocked ? "disabled" : ""}><option value="true" ${user.active ? "selected" : ""}>Active</option><option value="false" ${!user.active ? "selected" : ""}>Disabled</option></select></label></div>
        <p class="form-error" role="alert"></p>
        <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Save access</button></div>
      </form>
      <section class="reset-password-section">
        <div><strong>Reset password</strong><p>All active sessions for this user will be revoked.</p></div>
        <form id="reset-password-form" class="stack"><label>New temporary password<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required /></label><p class="form-error" role="alert"></p><div class="form-actions"><button class="button" type="submit">Reset password</button></div></form>
      </section>
    </div>`, false);
  const accessForm = document.querySelector("#user-access-form");
  accessForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: accessForm.elements.name.value,
      email: accessForm.elements.email.value,
      role: selfLocked ? user.role : accessForm.elements.role.value,
      active: selfLocked ? user.active : accessForm.elements.active.value === "true",
    };
    const result = await submitForm(accessForm, () => api(`/api/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: payload }), "User access updated");
    if (result) {
      closeModal();
      await renderUsers();
    }
  });
  const passwordForm = document.querySelector("#reset-password-form");
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await submitForm(passwordForm, () => api(`/api/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST", body: { password: passwordForm.elements.password.value } }), "Password reset; active sessions revoked");
    if (!result) return;
    closeModal();
    if (user.is_current_user) showLogin();
    else await renderUsers();
  });
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
  ["message_deleted", "Message deleted"],
  ["resend_email.sent", "Sent"],
  ["resend_email.delivered", "Delivered"],
  ["resend_email.delivery_delayed", "Delayed"],
  ["resend_email.bounced", "Bounced"],
  ["resend_email.complained", "Complained"],
  ["resend_email.opened", "Opened"],
  ["resend_email.clicked", "Clicked"],
];

const AUDIT_ACTION_LABELS = Object.fromEntries(
  AUDIT_ACTION_OPTIONS.filter(([value]) => value).map(([value, label]) => [value, label]),
);

function auditActionLabel(action) {
  const key = String(action ?? "");
  return AUDIT_ACTION_LABELS[key] || titleCase(key);
}

const AUDIT_ENTITY_OPTIONS = [
  ["", "All entities"],
  ["authentication", "Authentication"],
  ["session", "Session"],
  ["user", "User"],
  ["list", "List"],
  ["contact", "Contact"],
  ["campaign", "Campaign"],
  ["suppression", "Suppression"],
  ["message", "Message"],
  ["provider_event", "Provider event"],
];

async function renderAudit() {
  const filters = state.auditFilters;
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.entityType) params.set("entity_type", filters.entityType);
  if (filters.q) params.set("q", filters.q);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const queryString = params.toString();
  const data = await api(`/api/audit${queryString ? `?${queryString}` : ""}`);
  const filtering = Boolean(filters.action || filters.entityType || filters.q || filters.from || filters.to);
  const count = data.events.length;
  const actionOptions = AUDIT_ACTION_OPTIONS
    .map(([value, label]) => `<option value="${escapeHtml(value)}" ${filters.action === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  const entityOptions = AUDIT_ENTITY_OPTIONS
    .map(([value, label]) => `<option value="${escapeHtml(value)}" ${filters.entityType === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  const heading = filtering
    ? `${count.toLocaleString()} match${count === 1 ? "" : "es"}`
    : "Recent administrative activity";
  const filterBits = [];
  if (filters.q) filterBits.push(`“${escapeHtml(filters.q)}”`);
  if (filters.action) {
    filterBits.push(escapeHtml(AUDIT_ACTION_OPTIONS.find(([value]) => value === filters.action)?.[1] || titleCase(filters.action)));
  }
  if (filters.entityType) {
    filterBits.push(escapeHtml(AUDIT_ENTITY_OPTIONS.find(([value]) => value === filters.entityType)?.[1] || titleCase(filters.entityType)));
  }
  if (filters.from || filters.to) {
    filterBits.push(escapeHtml([filters.from || "…", filters.to || "…"].join(" → ")));
  }
  const filterNote = filterBits.length
    ? `<p class="audit-filter-note">Filtered by ${filterBits.join(" · ")}.</p>`
    : "";
  const emptyMarkup = filtering
    ? `<div class="empty-state"><div><div class="empty-mark">⌕</div><h2>No matching events</h2><p>Nothing matches these filters. Try clearing search, action, entity, or date range.</p><button class="button" id="clear-audit-filters">Clear filters</button></div></div>`
    : `<div class="empty-state"><div><p>No audit events yet.</p></div></div>`;
  const tableRows = data.events.map((event) => {
    const detail = formatAuditDetail(event.detail);
    const entityLabel = typeof event.entity_label === "string" ? event.entity_label.trim() : "";
    return `<tr>
      <td>${formatDate(event.created_at)}</td>
      <td>${escapeHtml(event.actor_name || "System / recipient")}</td>
      <td><strong>${escapeHtml(auditActionLabel(event.action))}</strong></td>
      <td class="audit-entity"><span>${escapeHtml(titleCase(event.entity_type))}</span>${entityLabel ? `<span class="subtext">${escapeHtml(entityLabel)}</span>` : ""}</td>
      <td class="audit-detail"><span>${escapeHtml(detail.primary)}</span>${detail.ip ? `<span class="subtext">from ${escapeHtml(detail.ip)}</span>` : ""}</td>
    </tr>`;
  }).join("");

  const sectionActions = [
    count ? `<button class="button" id="export-audit-csv">Export CSV</button>` : "",
    filtering ? `<button class="button" id="clear-audit-filters">Clear filters</button>` : "",
  ].filter(Boolean).join("");

  els.content.innerHTML = `
    <div class="section-lead"><div><h2>${heading}</h2><p>Authentication, imports, campaigns, delivery feedback, and suppressions.</p></div><div class="section-actions">${sectionActions}</div></div>
    ${filterNote}
    <div class="toolbar audit-toolbar">
      <div class="search"><input id="audit-search" type="search" placeholder="Search actor, action, entity, or detail" value="${escapeHtml(filters.q)}" aria-label="Search audit log" /></div>
      <select id="audit-action-filter" aria-label="Filter by action">${actionOptions}</select>
      <select id="audit-entity-filter" aria-label="Filter by entity type">${entityOptions}</select>
      <label class="delivery-date"><span>From</span><input id="audit-from" type="date" value="${escapeHtml(filters.from)}" aria-label="From date" /></label>
      <label class="delivery-date"><span>To</span><input id="audit-to" type="date" value="${escapeHtml(filters.to)}" aria-label="To date" /></label>
    </div>
    <section class="panel">${data.events.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead><tbody>${tableRows}</tbody></table></div>` : emptyMarkup}</section>`;

  const search = document.querySelector("#audit-search");
  const fromInput = document.querySelector("#audit-from");
  const toInput = document.querySelector("#audit-to");
  let searchTimer;

  const applyFilters = (next = {}) => {
    state.auditFilters = {
      ...state.auditFilters,
      ...next,
    };
    if ("q" in next) state.auditFilters._focusSearch = true;
    renderAudit();
  };
  const clearFilters = () => {
    state.auditFilters = { action: "", entityType: "", q: "", from: "", to: "" };
    renderAudit();
  };

  search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applyFilters({ q: search.value.trim() }), 280);
  });
  document.querySelector("#audit-action-filter")?.addEventListener("change", (event) => {
    applyFilters({ action: event.target.value || "" });
  });
  document.querySelector("#audit-entity-filter")?.addEventListener("change", (event) => {
    applyFilters({ entityType: event.target.value || "" });
  });
  fromInput?.addEventListener("change", () => {
    const from = fromInput.value || "";
    if (from && filters.to && from > filters.to) {
      toast("Start date must be on or before end date.", "error");
      fromInput.value = filters.from;
      return;
    }
    applyFilters({ from });
  });
  toInput?.addEventListener("change", () => {
    const to = toInput.value || "";
    if (filters.from && to && filters.from > to) {
      toast("End date must be on or after start date.", "error");
      toInput.value = filters.to;
      return;
    }
    applyFilters({ to });
  });
  document.querySelectorAll("#clear-audit-filters").forEach((button) => {
    button.addEventListener("click", clearFilters);
  });
  document.querySelector("#export-audit-csv")?.addEventListener("click", () => {
    exportAuditCsv(data.events);
  });

  if (state.auditFilters._focusSearch) {
    delete state.auditFilters._focusSearch;
    search?.focus();
    const len = search?.value.length || 0;
    search?.setSelectionRange(len, len);
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function exportAuditCsv(events) {
  const headers = ["created_at", "actor", "action", "entity_type", "entity_label", "entity_id", "detail", "ip"];
  const rows = events.map((event) => {
    const detail = formatAuditDetail(event.detail);
    return [
      event.created_at,
      event.actor_name || "System / recipient",
      event.action,
      event.entity_type,
      event.entity_label || "",
      event.entity_id || "",
      detail.primary === "—" ? "" : detail.primary,
      detail.ip || "",
    ].map(csvEscape).join(",");
  });
  const csv = [headers.join(","), ...rows].join("\n");
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audit-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${events.length.toLocaleString()} audit event${events.length === 1 ? "" : "s"}`);
}

function openModal(title, kicker, content, compact = false) {
  els.modalTitle.textContent = title;
  els.modalKicker.textContent = kicker;
  els.modalBody.innerHTML = content;
  els.modalBody.classList.toggle("compact", compact);
  els.modal.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  if (!els.modal.open) els.modal.showModal();
  requestAnimationFrame(() => els.modalBody.querySelector("input, select, textarea, button")?.focus());
}

function closeModal() {
  if (els.modal.open) els.modal.close();
  els.modalBody.innerHTML = "";
}

async function submitForm(form, request, successMessage) {
  const error = form.querySelector("[data-form-error]") || form.querySelector(".form-error");
  const submit = form.querySelector('[type="submit"]');
  if (error) error.textContent = "";
  if (submit) submit.disabled = true;
  try {
    const result = await request();
    toast(successMessage);
    return result;
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
    return null;
  } finally {
    if (submit) submit.disabled = false;
  }
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.textContent = "";
  const submit = els.loginForm.querySelector("button");
  submit.disabled = true;
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: document.querySelector("#login-email").value,
        password: document.querySelector("#login-password").value,
      },
    });
    showApp(session);
  } catch (error) {
    els.loginError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

els.nav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) navigate(button.dataset.view);
});

document.querySelector("#global-new-campaign").addEventListener("click", () => {
  if (can("campaigns.manage")) openCampaignComposer();
});
document.querySelector("#modal-close").addEventListener("click", closeModal);
document.querySelector("#mobile-nav-button").addEventListener("click", () => document.body.classList.toggle("nav-open"));
document.querySelector("#logout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch (_) { /* local logout still proceeds */ }
  showLogin();
});

els.modal.addEventListener("click", (event) => {
  if (event.target === els.modal) closeModal();
});

els.modal.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeModal();
});

els.content.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]");
  if (go) return navigate(go.dataset.go);
  if (event.target.closest("[data-new-campaign]") && can("campaigns.manage")) return openCampaignComposer();
  const campaignButton = event.target.closest("[data-action][data-id]");
  if (campaignButton) return campaignAction(campaignButton.dataset.action, campaignButton.dataset.id);
  const messageButton = event.target.closest("[data-message-id]");
  if (messageButton) return openMessage(messageButton.dataset.messageId);
  const userButton = event.target.closest("[data-user-id]");
  if (userButton) return openManageUserModal(userButton.dataset.userId);
});

async function initialize() {
  try {
    const session = await api("/api/session");
    showApp(session);
  } catch (_) {
    showLogin();
  }
}

initialize();
