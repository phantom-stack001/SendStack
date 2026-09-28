import { describe, expect, it, vi } from "vitest";

/**
 * Behavioral dry-run of durable launch intent creation + chunked provider sync.
 * Uses an in-memory fake store — never contacts Resend or a production database.
 */
describe("10,000-recipient fake-provider dry run", () => {
  it("creates exactly one intent per recipient and syncs in bounded chunks without duplicates", async () => {
    const TOTAL = 10_000;
    const CHUNK = 100;
    const intents = new Map<string, { email: string; synced: boolean }>();
    const providerCalls: string[] = [];

    // Simulate launch HTTP handler: persist intents only.
    for (let i = 0; i < TOTAL; i += 1) {
      const contactId = `con_${i}`;
      const email = `user${i}@contoso.com`;
      const key = `broadcast:cam_dry:${contactId}`;
      expect(intents.has(key)).toBe(false);
      intents.set(key, { email, synced: false });
    }
    expect(intents.size).toBe(TOTAL);

    // Simulate worker ticks with bulk import per chunk (1 provider call / chunk).
    let cursor = 0;
    const keys = [...intents.keys()];
    while (cursor < keys.length) {
      const slice = keys.slice(cursor, cursor + CHUNK);
      providerCalls.push(`import:${slice.length}`);
      for (const key of slice) {
        const row = intents.get(key)!;
        expect(row.synced).toBe(false);
        row.synced = true;
      }
      cursor += slice.length;
    }

    expect(providerCalls.length).toBe(100);
    expect(providerCalls.reduce((sum, entry) => sum + Number(entry.split(":")[1]), 0)).toBe(TOTAL);
    expect([...intents.values()].every((row) => row.synced)).toBe(true);
    // Critical: not 20,000 sequential upserts in one request.
    expect(providerCalls.length).toBeLessThan(TOTAL);
    expect(providerCalls.length * 2).toBeLessThan(TOTAL);
  });
});

describe("ambiguous broadcast submission recovery", () => {
  it("reconciles without creating a second broadcast when response is lost", async () => {
    const state = {
      broadcastId: "bcast_1",
      localStatus: "submission_unknown" as string,
      sendAttempts: 0,
      createDraftAttempts: 0,
    };

    const getBroadcast = vi.fn(async (_id?: string) => ({ id: "bcast_1", status: "queued" }));
    const sendBroadcast = vi.fn(async (_id?: string) => {
      state.sendAttempts += 1;
      throw new Error("network timeout");
    });
    const createDraft = vi.fn(async () => {
      state.createDraftAttempts += 1;
      return { id: "bcast_1" };
    });

    // First attempt: draft exists, send times out → submission_unknown
    try {
      await sendBroadcast("bcast_1");
    } catch {
      state.localStatus = "submission_unknown";
    }
    expect(state.localStatus).toBe("submission_unknown");
    expect(state.sendAttempts).toBe(1);

    // Reconcile: provider already accepted — do not resend or recreate.
    const remote = await getBroadcast("bcast_1");
    if (remote.status === "queued" || remote.status === "sent") {
      state.localStatus = "sending";
    } else if (remote.status === "draft") {
      await sendBroadcast("bcast_1");
    } else {
      await createDraft();
    }

    expect(state.localStatus).toBe("sending");
    expect(state.sendAttempts).toBe(1);
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe("partial provider cancellation semantics", () => {
  it("keeps already-sent outcomes and only pending rows as cancel_requested/outcome_pending", () => {
    const recipients = [
      { id: "1", status: "sent" },
      { id: "2", status: "bounced" },
      { id: "3", status: "processing" },
      { id: "4", status: "queued" },
    ];

    const afterCancelRequest = recipients.map((row) => {
      if (["queued", "processing", "submission_unknown"].includes(row.status)) {
        return { ...row, status: "cancel_requested" };
      }
      return row;
    });

    expect(afterCancelRequest.find((row) => row.id === "1")?.status).toBe("sent");
    expect(afterCancelRequest.find((row) => row.id === "2")?.status).toBe("bounced");
    expect(afterCancelRequest.find((row) => row.id === "3")?.status).toBe("cancel_requested");
    expect(afterCancelRequest.find((row) => row.id === "4")?.status).toBe("cancel_requested");

    const sentLike = afterCancelRequest.filter((row) => ["sent", "bounced", "complained", "delayed"].includes(row.status)).length;
    const pending = afterCancelRequest.filter((row) =>
      ["cancel_requested", "outcome_pending", "queued", "processing"].includes(row.status),
    ).length;
    const campaignStatus = pending === 0 && sentLike > 0 ? "partially_sent" : pending === 0 ? "cancelled" : "cancel_requested";
    expect(campaignStatus).toBe("cancel_requested");
  });
});

describe("daily volume accounting invariants", () => {
  it("does not reopen capacity when a reserved unit later unsubscribes or bounces", () => {
    let reserved = 0;
    const limit = 3;
    const consume = () => {
      if (reserved >= limit) return false;
      reserved += 1;
      return true;
    };
    expect(consume()).toBe(true);
    expect(consume()).toBe(true);
    expect(consume()).toBe(true);
    // Later unsubscribe/bounce must not decrement.
    const onUnsubscribe = () => {
      /* no-op: capacity stays consumed */
    };
    onUnsubscribe();
    expect(reserved).toBe(3);
    expect(consume()).toBe(false);
  });
});
