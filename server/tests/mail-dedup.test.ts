import { config } from "dotenv";
import { describe, expect, it } from "vitest";

config();

import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { performIdempotentSend } from "../mail/idempotency.js";
import { withPgAdvisoryLock, type MailLock } from "../mail/lock.js";
import { previewFromPart } from "../mail/preview.js";
import { appendIfMessageMissing, isCrossFolderCopy, isSameFolderDuplicate } from "../mail/sent-copy.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mutex(): MailLock {
  let chain: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

describe("sent copy deduplication", () => {
  it("appends one copy when identical requests overlap", async () => {
    const present = new Set<string>();
    let appends = 0;
    const lock = mutex();
    const attempt = () =>
      appendIfMessageMissing({
        lock,
        exists: async () => {
          await delay(25);
          return present.has("same-id");
        },
        append: async () => {
          await delay(25);
          appends += 1;
          present.add("same-id");
          return true;
        },
      });

    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(appends).toBe(1);
    expect(results.filter((result) => result === "appended")).toHaveLength(1);
    expect(results.filter((result) => result === "already_present")).toHaveLength(2);
  });

  it("keeps a self-addressed message in both Inbox and Sent", () => {
    const inbox = { folder: "INBOX", messageId: "<same@ctn-sk.com>" };
    const sent = { folder: "Sent", messageId: "<same@ctn-sk.com>" };
    expect(isCrossFolderCopy(inbox, sent)).toBe(true);
    expect(isSameFolderDuplicate(inbox, sent)).toBe(false);
    expect(isSameFolderDuplicate(sent, { ...sent })).toBe(true);
  });

  it("still appends distinct messages", async () => {
    const present = new Set<string>();
    let appends = 0;
    const lock = mutex();
    const attempt = (id: string) =>
      appendIfMessageMissing({
        lock,
        exists: async () => present.has(id),
        append: async () => {
          appends += 1;
          present.add(id);
          return true;
        },
      });

    await Promise.all([attempt("one"), attempt("two")]);
    expect(appends).toBe(2);
  });
});

describe("idempotent test send", () => {
  it("sends once when the same key is submitted concurrently", async () => {
    const store = new Map<string, { id: string; status: string }>();
    let sends = 0;
    const lock = mutex();
    const run = () =>
      performIdempotentSend({
        lock,
        find: async () => {
          await delay(15);
          return store.get("key") ?? null;
        },
        prepare: async () => {},
        gate: async () => null,
        insert: async () => {
          await delay(15);
          if (store.has("key")) return null;
          const row = { id: "row-1", status: "pending" };
          store.set("key", row);
          return row;
        },
        send: async (row) => {
          sends += 1;
          await delay(20);
          store.set("key", { ...row, status: "accepted" });
          return "accepted";
        },
      });

    const results = await Promise.all([run(), run(), run()]);
    expect(sends).toBe(1);
    expect(results.filter((result) => result.type === "sent")).toHaveLength(1);
    expect(results.filter((result) => result.type === "replay")).toHaveLength(2);
  });
});

describe("message preview", () => {
  it("drops scripts and remote image markup from the list preview", () => {
    const preview = previewFromPart(
      Buffer.from('<script>alert(1)</script><p>Hello from CTN</p><img src="https://tracker.example/pixel.gif">'),
    );
    expect(preview).toBe("Hello from CTN");
    expect(preview).not.toContain("alert");
    expect(preview).not.toContain("tracker.example");
  });
});

describe("mailbox advisory lock", () => {
  it("lets only one identical critical section run at a time", async () => {
    const env = loadEnv();
    const { db, client } = createDb(env);
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    try {
      const task = () =>
        withPgAdvisoryLock(db, "sendstack-mail-lock-test-xact", async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(200);
          active -= 1;
          runs += 1;
        });
      await Promise.all([task(), task(), task()]);
      expect(runs).toBe(3);
      expect(maxActive).toBe(1);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 30_000);
});
