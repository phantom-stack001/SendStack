import { escapeHtml } from "./html-escape";
import { loadSendingIdentity, type SendingIdentity } from "./sending-identity";

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

/** Escape user-configured identity values for HTML injection. */
export function escapeIdentity(value: string): string {
  return escapeHtml(value);
}

export function renderComplianceFooterHtml(parts: ComplianceFooterParts): string {
  const company = escapeIdentity(parts.companyName);
  const postal = escapeIdentity(parts.postalAddress);
  const contact = escapeIdentity(parts.contactEmail);
  return [
    '<div class="sendstack-compliance-footer" style="margin-top:32px;padding-top:16px;border-top:1px solid #d0d7e2;font-size:12px;line-height:1.6;color:#5b6b7c">',
    `<p style="margin:0 0 8px">${company}<br>${postal}</p>`,
    `<p style="margin:0 0 8px">Contact: <a href="mailto:${contact}">${contact}</a></p>`,
    `<p style="margin:0"><a href="${parts.unsubscribeUrlToken}">Unsubscribe</a></p>`,
    "</div>",
  ].join("");
}

export function renderComplianceFooterText(parts: ComplianceFooterParts): string {
  return [
    "",
    "---",
    parts.companyName,
    parts.postalAddress,
    `Contact: ${parts.contactEmail}`,
    `Unsubscribe: ${parts.unsubscribeUrlToken}`,
  ].join("\n");
}

const FOOTER_DIV_RE =
  /<div\b[^>]*\bclass=["'][^"']*\bsendstack-compliance-footer\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi;

/**
 * Always inject the canonical server footer.
 * Author-supplied marker text must not suppress injection — existing footers are stripped first.
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

  let html = (htmlBody ?? "").replace(FOOTER_DIV_RE, "");
  let text = textBody ?? "";

  // Strip prior canonical text footers (marker + unsubscribe token lines).
  text = text.replace(
    /\n---\n[\s\S]*?Unsubscribe:\s*\{\{\{?RESEND_UNSUBSCRIBE_URL\}?\}\}|\n---\n[\s\S]*?Unsubscribe:\s*\{\{unsubscribe_url\}\}/gi,
    "",
  );

  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${footerHtml}</body>`);
  } else {
    html = `${html.trimEnd()}\n${footerHtml}`;
  }

  text = `${text.trimEnd()}\n${footerText}\n`;

  // Guarantee unsubscribe token presence for validators / Resend.
  if (
    !html.includes(parts.unsubscribeUrlToken) &&
    !html.includes("{{unsubscribe_url}}") &&
    !html.includes("{{{RESEND_UNSUBSCRIBE_URL}}}")
  ) {
    html = `${html}\n<p><a href="${parts.unsubscribeUrlToken}">Unsubscribe</a></p>`;
  }
  if (
    !text.includes(parts.unsubscribeUrlToken) &&
    !text.includes("{{unsubscribe_url}}") &&
    !text.includes("{{{RESEND_UNSUBSCRIBE_URL}}}")
  ) {
    text = `${text.trimEnd()}\nUnsubscribe: ${parts.unsubscribeUrlToken}\n`;
  }

  return { html, text };
}

/** Verify company name, postal address, contact email, and unsubscribe link are present. */
export function assertComplianceFooterPresent(
  html: string,
  text: string,
  identity: SendingIdentity = loadSendingIdentity(),
): void {
  const contactEmail = identity.replyToEmail || identity.fromEmail;
  const missing: string[] = [];

  if (!identity.companyName || (!html.includes(identity.companyName) && !text.includes(identity.companyName))) {
    missing.push("company name");
  }
  if (
    !identity.postalAddress ||
    (!html.includes(identity.postalAddress) && !text.includes(identity.postalAddress))
  ) {
    missing.push("postal address");
  }
  if (!contactEmail || (!html.includes(contactEmail) && !text.includes(contactEmail))) {
    missing.push("contact email");
  }

  const hasUnsubHtml =
    /href\s*=\s*["']?\{\{unsubscribe_url\}\}/i.test(html) ||
    /href\s*=\s*["']?\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/i.test(html) ||
    html.includes("sendstack-compliance-footer");
  const hasUnsubText =
    /\{\{unsubscribe_url\}\}/.test(text) || /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/.test(text);
  if (!hasUnsubHtml || !hasUnsubText) {
    missing.push("unsubscribe link");
  }

  if (missing.length) {
    throw new Error(`Compliance footer incomplete after injection: missing ${missing.join(", ")}.`);
  }
}
