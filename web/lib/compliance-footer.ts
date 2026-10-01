import { escapeHtml } from "./html-escape";
import { loadSendingIdentity, type SendingIdentity } from "./sending-identity";

/** Unique markers. They are not a regex over author punctuation. */
export const COMPLIANCE_HTML_START = "<!-- SENDSTACK_COMPLIANCE_FOOTER_START -->";
export const COMPLIANCE_HTML_END = "<!-- SENDSTACK_COMPLIANCE_FOOTER_END -->";
export const COMPLIANCE_TEXT_START = "[[SENDSTACK_COMPLIANCE_FOOTER_START]]";
export const COMPLIANCE_TEXT_END = "[[SENDSTACK_COMPLIANCE_FOOTER_END]]";

export type ComplianceFooterParts = {
  companyName: string;
  postalAddress: string;
  contactEmail: string;
  unsubscribeUrlToken: string;
};

export function buildComplianceFooterParts(
  identity = loadSendingIdentity(),
  options?: { broadcast?: boolean },
): ComplianceFooterParts {
  if (!identity.companyName || !identity.postalAddress) {
    throw new Error("Compliance identity (company name and postal address) is required.");
  }
  const contactEmail = identity.replyToEmail || identity.fromEmail;
  if (!contactEmail) {
    throw new Error("A monitored contact address is required for the compliance footer.");
  }
  return {
    companyName: identity.companyName,
    postalAddress: identity.postalAddress,
    contactEmail,
    unsubscribeUrlToken: options?.broadcast ? "{{{RESEND_UNSUBSCRIBE_URL}}}" : "{{unsubscribe_url}}",
  };
}

export function escapeIdentity(value: string): string {
  return escapeHtml(value);
}

const CONCEALING_STYLE =
  /(?<![\w-])display\s*:\s*none|(?<![\w-])visibility\s*:\s*hidden|(?<![\w-])opacity\s*:\s*0|(?<![\w-])font-size\s*:\s*0|(?<![\w-])color\s*:\s*transparent|(?<![\w-])height\s*:\s*0|(?<![\w-])width\s*:\s*0|(?<![\w-])overflow\s*:\s*hidden/i;

/**
 * Author CSS can target the footer via selectors. Drop entire <style> blocks, and
 * remove only concealing declarations from inline style attributes so layout CSS survives.
 */
export function stripConcealingStyles(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\sstyle\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi, (match, quoted: string) => {
      const quote = quoted[0];
      const raw = quoted.slice(1, -1);
      const cleaned = raw
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !CONCEALING_STYLE.test(part))
        .join(";");
      return cleaned ? ` style=${quote}${cleaned}${quote}` : "";
    });
}

export function renderComplianceFooterHtml(parts: ComplianceFooterParts): string {
  const company = escapeIdentity(parts.companyName);
  const postal = escapeIdentity(parts.postalAddress);
  const contact = escapeIdentity(parts.contactEmail);
  return [
    COMPLIANCE_HTML_START,
    '<div class="sendstack-compliance-footer" style="margin-top:32px;padding-top:16px;border-top:1px solid #d0d7e2;font-size:12px;line-height:1.6;color:#5b6b7c;display:block;visibility:visible;opacity:1">',
    `<p style="margin:0 0 8px;font-size:12px;color:#5b6b7c">${company}<br>${postal}</p>`,
    `<p style="margin:0 0 8px;font-size:12px;color:#5b6b7c">Contact: <a href="mailto:${contact}">${contact}</a></p>`,
    `<p style="margin:0;font-size:12px"><a href="${parts.unsubscribeUrlToken}">Unsubscribe</a></p>`,
    "</div>",
    COMPLIANCE_HTML_END,
  ].join("");
}

export function renderComplianceFooterText(parts: ComplianceFooterParts): string {
  return [
    COMPLIANCE_TEXT_START,
    parts.companyName,
    parts.postalAddress,
    `Contact: ${parts.contactEmail}`,
    `Unsubscribe: ${parts.unsubscribeUrlToken}`,
    COMPLIANCE_TEXT_END,
  ].join("\n");
}

function rejectMarkerCollision(value: string, label: string): void {
  if (
    value.includes(COMPLIANCE_HTML_START) ||
    value.includes(COMPLIANCE_HTML_END) ||
    value.includes(COMPLIANCE_TEXT_START) ||
    value.includes(COMPLIANCE_TEXT_END)
  ) {
    throw new Error(`Author ${label} contains a reserved compliance-footer marker.`);
  }
}

function alreadyCanonical(html: string, text: string, footerHtml: string, footerText: string): boolean {
  return html.includes(footerHtml) && text.includes(footerText);
}

/**
 * Produce the final HTML and text exactly once.
 * Repeated calls with the same identity are byte-for-byte idempotent.
 * Author content containing "---" or "Unsubscribe:" is preserved.
 */
export function applyComplianceFooter(
  htmlBody: string,
  textBody: string,
  identity: SendingIdentity = loadSendingIdentity(),
  options?: { broadcast?: boolean },
): { html: string; text: string } {
  const parts = buildComplianceFooterParts(identity, options);
  const footerHtml = renderComplianceFooterHtml(parts);
  const footerText = renderComplianceFooterText(parts);

  let html = htmlBody ?? "";
  let text = textBody ?? "";

  // Sanitize concealing CSS first so stored visual templates and post-hoc style
  // blocks cannot hide the footer. Preserve non-concealing author layout styles.
  html = stripConcealingStyles(html);
  if (CONCEALING_STYLE.test(html)) {
    throw new Error("Campaign HTML contains a style that can conceal the compliance footer.");
  }

  if (alreadyCanonical(html, text, footerHtml, footerText)) {
    return { html, text };
  }

  rejectMarkerCollision(html, "HTML");
  rejectMarkerCollision(text, "text");

  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${footerHtml}</body>`);
  } else {
    html = `${html.trimEnd()}\n${footerHtml}`;
  }
  text = `${text.trimEnd()}\n${footerText}\n`;
  return { html, text };
}

export function assertComplianceFooterPresent(
  html: string,
  text: string,
  identity: SendingIdentity = loadSendingIdentity(),
): void {
  const contactEmail = identity.replyToEmail || identity.fromEmail;
  const missing: string[] = [];

  if (!html.includes(COMPLIANCE_HTML_START) || !html.includes(COMPLIANCE_HTML_END)) {
    missing.push("html footer markers");
  }
  if (!text.includes(COMPLIANCE_TEXT_START) || !text.includes(COMPLIANCE_TEXT_END)) {
    missing.push("text footer markers");
  }
  if (!identity.companyName || !html.includes(identity.companyName) || !text.includes(identity.companyName)) {
    missing.push("company name");
  }
  if (
    !identity.postalAddress ||
    !html.includes(identity.postalAddress) ||
    !text.includes(identity.postalAddress)
  ) {
    missing.push("postal address");
  }
  if (!contactEmail || !html.includes(contactEmail) || !text.includes(contactEmail)) {
    missing.push("contact email");
  }

  const hasUnsubHtml =
    html.includes('href="{{unsubscribe_url}}"') || html.includes('href="{{{RESEND_UNSUBSCRIBE_URL}}}"');
  const hasUnsubText =
    text.includes("{{unsubscribe_url}}") || text.includes("{{{RESEND_UNSUBSCRIBE_URL}}}");
  if (!hasUnsubHtml || !hasUnsubText) {
    missing.push("unsubscribe link");
  }

  if (missing.length) {
    throw new Error(`Compliance footer incomplete after injection: missing ${missing.join(", ")}.`);
  }
}
