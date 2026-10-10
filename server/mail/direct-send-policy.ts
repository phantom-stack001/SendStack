import { isValidEmail, normalizeEmail } from "../lib/email-normalization.js";
import { DIRECT_SEND_LIMITS } from "./rate-limit.js";

export type RecipientFields = {
  to: string[];
  cc: string[];
  bcc: string[];
};

export type ContactConsent = {
  subscriptionStatus: "subscribed" | "unsubscribed" | "pending" | "unknown";
};

export type RecipientPolicyInput = {
  to: string[];
  cc: string[];
  bcc: string[];
  allowlist: string[];
  contactsByEmail: Map<string, ContactConsent>;
  suppressed: Set<string>;
};

export type RecipientPolicyResult =
  | { ok: true; to: string[]; cc: string[]; bcc: string[] }
  | { ok: false; message: string };

const FIELD_LABEL = { to: "To", cc: "Cc", bcc: "Bcc" } as const;

export function parseAddressList(value: string) {
  return value
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizeRecipientField(values: string[]) {
  const accepted: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of parseAddressList(value)) {
      if (!isValidEmail(part)) {
        invalid.push(part);
        continue;
      }
      const email = normalizeEmail(part);
      if (seen.has(email)) continue;
      seen.add(email);
      accepted.push(email);
    }
  }
  return { accepted, invalid };
}

export function assessSender(requestedSender: string, authorizedSender: string) {
  const authorized = normalizeEmail(authorizedSender);
  const requested = requestedSender.trim() ? normalizeEmail(requestedSender) : "";
  if (!requested || requested === authorized) {
    return { ok: true as const, sender: authorized };
  }
  return {
    ok: false as const,
    message: `This draft uses ${requested}, but SendStack can only send as ${authorized}. Update the sender before sending.`,
    authorizedSender: authorized,
  };
}

function eligibilityMessage(email: string, contact: ContactConsent | undefined, suppressed: Set<string>) {
  if (suppressed.has(email)) {
    return `${email} is suppressed and cannot receive this message.`;
  }
  if (!contact) return null;
  if (contact.subscriptionStatus === "unsubscribed") {
    return `${email} is unsubscribed and cannot receive this message.`;
  }
  if (contact.subscriptionStatus === "unknown" || contact.subscriptionStatus === "pending") {
    return `${email} does not have recorded permission to receive this message.`;
  }
  return null;
}

export function assessDirectRecipients(input: RecipientPolicyInput): RecipientPolicyResult {
  const fields = {
    to: normalizeRecipientField(input.to),
    cc: normalizeRecipientField(input.cc),
    bcc: normalizeRecipientField(input.bcc),
  } as const;
  for (const key of ["to", "cc", "bcc"] as const) {
    if (fields[key].invalid.length > 0) {
      return {
        ok: false,
        message: `${FIELD_LABEL[key]} contains an invalid email address: ${fields[key].invalid[0]}.`,
      };
    }
  }
  if (fields.to.accepted.length === 0) {
    return { ok: false, message: "Add at least one To recipient." };
  }

  const seen = new Map<string, "to" | "cc" | "bcc">();
  for (const key of ["to", "cc", "bcc"] as const) {
    for (const email of fields[key].accepted) {
      const previous = seen.get(email);
      if (previous) {
        return {
          ok: false,
          message: `${email} is listed in both ${FIELD_LABEL[previous]} and ${FIELD_LABEL[key]}.`,
        };
      }
      seen.set(email, key);
    }
  }

  if (seen.size > DIRECT_SEND_LIMITS.maxRecipients) {
    return {
      ok: false,
      message: `A message can include at most ${DIRECT_SEND_LIMITS.maxRecipients} recipients.`,
    };
  }

  const allowlist = new Set(input.allowlist.map((email) => normalizeEmail(email)));
  for (const email of seen.keys()) {
    if (!allowlist.has(email)) {
      return {
        ok: false,
        message: `${email} is not an authorized recipient. Direct sending is limited to the configured test recipient.`,
      };
    }
    const blocked = eligibilityMessage(email, input.contactsByEmail.get(email), input.suppressed);
    if (blocked) return { ok: false, message: blocked };
  }

  return {
    ok: true,
    to: fields.to.accepted,
    cc: fields.cc.accepted,
    bcc: fields.bcc.accepted,
  };
}

export function recipientSummary(to: string[]) {
  return to.join(", ");
}

export type StoredSendStatus =
  | "pending"
  | "submitting"
  | "accepted"
  | "rejected"
  | "failed"
  | "uncertain";

/** What a later request with the same key may do. Pending has not reached SMTP. */
export function retryDecision(status: string): "resume" | "uncertain" | "replay" {
  if (status === "pending") return "resume";
  if (status === "submitting") return "uncertain";
  return "replay";
}
