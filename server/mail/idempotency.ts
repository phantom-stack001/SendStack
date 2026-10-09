import type { MailLock } from "./lock.js";

export type IdempotentSendResult<TRow, TValue> =
  | { type: "replay"; row: TRow }
  | { type: "busy" }
  | { type: "blocked"; message: string }
  | { type: "sent"; value: TValue };

/**
 * One locked pass: replay a finished request, refuse a still-pending one,
 * or insert and send exactly once.
 */
export async function performIdempotentSend<TRow extends { status: string }, TValue>(options: {
  lock: MailLock;
  find: () => Promise<TRow | null>;
  prepare: () => Promise<void>;
  gate: () => Promise<string | null>;
  insert: () => Promise<TRow | null>;
  send: (row: TRow) => Promise<TValue>;
}): Promise<IdempotentSendResult<TRow, TValue>> {
  return options.lock(async () => {
    await options.prepare();
    const existing = await options.find();
    if (existing) {
      return existing.status === "pending" ? { type: "busy" } : { type: "replay", row: existing };
    }

    const blocked = await options.gate();
    if (blocked) {
      return { type: "blocked", message: blocked };
    }

    const created = await options.insert();
    if (!created) {
      const raced = await options.find();
      if (!raced || raced.status === "pending") {
        return { type: "busy" };
      }
      return { type: "replay", row: raced };
    }

    const value = await options.send(created);
    return { type: "sent", value };
  });
}
