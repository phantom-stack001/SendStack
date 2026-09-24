import { createHmac, timingSafeEqual } from "crypto";

export function isTimestampFresh(timestamp: string, maxAgeSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return false;
  return Math.abs(nowSeconds - value) <= maxAgeSeconds;
}

export function verifySvixSignature(
  secret: string,
  body: string,
  messageId: string,
  timestamp: string,
  signatureHeader: string,
): boolean {
  if (!secret || !messageId || !timestamp || !signatureHeader) return false;
  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(encodedSecret, "base64");
  const expected = createHmac("sha256", key).update(`${messageId}.${timestamp}.${body}`).digest("base64");
  return signatureHeader.split(" ").some((entry) => {
    const value = entry.replace(/^v1,/, "");
    const actualBuffer = Buffer.from(value);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  });
}

export function shouldReuseExistingBroadcast(providerBroadcastId: string | null | undefined): boolean {
  return Boolean(providerBroadcastId && String(providerBroadcastId).trim());
}
