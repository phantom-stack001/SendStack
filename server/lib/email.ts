import type { ServerEnv } from "../env.js";

export type TransactionalEmailPayload = {
  to: string;
  subject: string;
  text: string;
};

export type EmailDeliveryResult =
  | { delivered: true }
  | { delivered: false; devOnly: true; preview?: string };

export async function sendTransactionalEmail(
  env: ServerEnv,
  payload: TransactionalEmailPayload,
): Promise<EmailDeliveryResult> {
  if (env.AUTH_EMAIL_DELIVERY === "disabled") {
    throw new Error("Email delivery is not configured on this server.");
  }

  if (env.AUTH_EMAIL_DELIVERY === "console") {
    if (env.NODE_ENV === "production") {
      console.warn(
        "[auth-email] AUTH_EMAIL_DELIVERY=console in production — messages are not sent to recipients.",
      );
    }
    console.info("[auth-email]", {
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
    });
    return { delivered: false, devOnly: true, preview: payload.text };
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_FROM } = env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM) {
    throw new Error("SMTP delivery is selected but SMTP_HOST, SMTP_PORT, or SMTP_FROM is missing.");
  }

  throw new Error(
    "SMTP email delivery is not configured in this build. Set AUTH_EMAIL_DELIVERY=console for development or wire a transactional provider.",
  );
}
