import { describe, expect, it, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const connectMock = vi.fn();

vi.mock("../lib/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
  getPool: () => ({ connect: connectMock }),
}));

vi.mock("../lib/suppressions", () => ({
  applySuppression: vi.fn(async () => undefined),
}));

vi.mock("../lib/launch-jobs", () => ({
  reconcileCampaignAfterCancel: vi.fn(async () => undefined),
}));

import { processResendWebhookEvent } from "../lib/providers/webhook-processor";
import { canTransitionMessageStatus } from "../lib/delivery-status";

describe("transactional webhook claiming", () => {
  beforeEach(() => {
    queryMock.mockReset();
    connectMock.mockReset();
  });

  it("ignores a second concurrent claim for the same event id", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // insert
        .mockResolvedValueOnce({ rows: [] }) // claim failed
        .mockResolvedValueOnce({ rows: [{ processed_at: null }] }) // still unprocessed
        .mockResolvedValueOnce(undefined), // COMMIT
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    const first = await processResendWebhookEvent(
      "evt_same",
      { type: "email.delivered", data: { email_id: "e1", to: ["a@contoso.com"] } },
      "{}",
      "worker_a",
    );
    expect(first.duplicate).toBe(false);
    expect(first.processed).toBe(false);
    expect(first.retryable).toBe(true);
  });

  it("returns duplicate success only when the event is already processed", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // insert
        .mockResolvedValueOnce({ rows: [] }) // claim failed
        .mockResolvedValueOnce({ rows: [{ processed_at: "2026-01-01T00:00:00Z" }] })
        .mockResolvedValueOnce(undefined), // COMMIT
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    const result = await processResendWebhookEvent(
      "evt_done",
      { type: "email.delivered", data: { email_id: "e1", to: ["a@contoso.com"] } },
      "{}",
    );
    expect(result.duplicate).toBe(true);
    expect(result.processed).toBe(true);
  });
});

describe("out-of-order webhook transitions", () => {
  it("prevents delivered from regressing to submitted", () => {
    expect(canTransitionMessageStatus("delivered", "submitted")).toBe(false);
    expect(canTransitionMessageStatus("delayed", "delivered")).toBe(true);
    expect(canTransitionMessageStatus("submitted", "bounced")).toBe(true);
    expect(canTransitionMessageStatus("complained", "delivered")).toBe(false);
  });
});
