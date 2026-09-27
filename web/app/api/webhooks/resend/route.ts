import { processResendWebhookEvent, type ResendWebhookEvent } from "@/lib/providers/webhook-processor";
import { isTimestampFresh, verifySvixSignature } from "@/lib/providers/webhook";

export async function POST(request: Request) {
  const body = await request.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";
  const messageId = request.headers.get("svix-id") ?? "";
  const timestamp = request.headers.get("svix-timestamp") ?? "";
  const signatureHeader = request.headers.get("svix-signature") ?? "";
  if (!isTimestampFresh(timestamp, 300) || !verifySvixSignature(secret, body, messageId, timestamp, signatureHeader)) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  const event = JSON.parse(body) as ResendWebhookEvent;
  const eventId = messageId;
  if (!eventId) {
    return Response.json({ error: "Missing webhook event id." }, { status: 400 });
  }

  const result = await processResendWebhookEvent(eventId, event, body);
  if (result.duplicate) {
    return Response.json({ received: true, duplicate: true });
  }
  return Response.json({ received: true, processed: result.processed });
}
