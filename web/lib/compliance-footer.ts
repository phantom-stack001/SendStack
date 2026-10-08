import { loadSendingIdentity, type SendingIdentity } from "./sending-identity";

/** Legacy markers kept for detecting old author content that still embeds them. */
export const COMPLIANCE_HTML_START = "<!-- SENDSTACK_COMPLIANCE_FOOTER_START -->";
export const COMPLIANCE_HTML_END = "<!-- SENDSTACK_COMPLIANCE_FOOTER_END -->";
export const COMPLIANCE_TEXT_START = "[[SENDSTACK_COMPLIANCE_FOOTER_START]]";
export const COMPLIANCE_TEXT_END = "[[SENDSTACK_COMPLIANCE_FOOTER_END]]";

/**
 * Pass-through: outbound mail is the authored body only (plus merge fields at send time).
 * Company/postal/contact blocks are not appended — same as a normal Spacemail client send.
 */
export function applyComplianceFooter(
  htmlBody: string,
  textBody: string,
  _identity: SendingIdentity = loadSendingIdentity(),
  _options?: { broadcast?: boolean },
): { html: string; text: string } {
  return { html: htmlBody ?? "", text: textBody ?? "" };
}

/** No-op: footers are no longer injected. Kept for call-site compatibility. */
export function assertComplianceFooterPresent(
  _html: string,
  _text: string,
  _identity: SendingIdentity = loadSendingIdentity(),
): void {}
