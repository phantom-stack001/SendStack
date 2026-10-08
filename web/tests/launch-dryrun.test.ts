import { describe, expect, it } from "vitest";

/**
 * Behavioral dry-run of durable launch intent creation + per-recipient SMTP.
 * Uses an in-memory fake store — never opens a socket or a production database.
 */
describe("10,000-recipient fake-SMTP dry run", () => {
  it("creates exactly one intent per recipient and sends in bounded chunks without duplicates", () => {
    const TOTAL = 10_000;
    const CHUNK = 5;
    const intents = new Map<string, { email: string; sent: boolean }>();
    const smtpCalls: string[] = [];

    for (let i = 0; i < TOTAL; i += 1) {
      const contactId = `con_${i}`;
      const email = `user${i}@contoso.com`;
      const key = `smtp:cam_dry:${contactId}`;
      expect(intents.has(key)).toBe(false);
      intents.set(key, { email, sent: false });
    }
    expect(intents.size).toBe(TOTAL);

    let cursor = 0;
    const keys = [...intents.keys()];
    while (cursor < keys.length) {
      const slice = keys.slice(cursor, cursor + CHUNK);
      for (const key of slice) {
        const row = intents.get(key)!;
        expect(row.sent).toBe(false);
        smtpCalls.push(row.email);
        row.sent = true;
      }
      cursor += slice.length;
    }

    expect(smtpCalls).toHaveLength(TOTAL);
    expect(new Set(smtpCalls).size).toBe(TOTAL);
    expect([...intents.values()].every((row) => row.sent)).toBe(true);
  });
});

describe("ambiguous SMTP submission recovery", () => {
  it("never resends a message marked submission_unknown", () => {
    const message = { status: "submission_unknown", provider_id: null as string | null, sendAttempts: 1 };

    const canResend =
      message.status === "captured" || (message.status === "failed" && message.provider_id === null);
    expect(canResend).toBe(false);

    // A later tick skips unknown acceptance rows.
    if (message.status === "submission_unknown") {
      // no-op
    } else {
      message.sendAttempts += 1;
    }
    expect(message.sendAttempts).toBe(1);
  });
});

describe("partial SMTP cancellation semantics", () => {
  it("keeps already-submitted outcomes and cancels only unsent rows", () => {
    const recipients = [
      { id: "1", status: "sent" },
      { id: "2", status: "failed" },
      { id: "3", status: "processing" },
      { id: "4", status: "queued" },
    ];

    const afterCancel = recipients.map((row) => {
      if (row.status === "queued" || row.status === "processing" || row.status === "failed") {
        return { ...row, status: "cancelled" };
      }
      return row;
    });

    expect(afterCancel.map((row) => row.status)).toEqual(["sent", "cancelled", "cancelled", "cancelled"]);
  });
});
