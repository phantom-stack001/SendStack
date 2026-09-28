import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const connectMock = vi.fn();

vi.mock("../lib/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
  getPool: () => ({ connect: connectMock }),
}));

const applySuppressionMock = vi.fn();
vi.mock("../lib/suppressions", () => ({
  applySuppression: (...args: unknown[]) => applySuppressionMock(...args),
}));

vi.mock("../lib/launch-jobs", () => ({
  reconcileCampaignAfterCancel: vi.fn(async () => undefined),
}));

import { processResendWebhookEvent } from "../lib/providers/webhook-processor";

function setupClient(handler: (sql: string) => { rows: unknown[] }) {
  const client = {
    query: vi.fn(async (sql: string) => handler(String(sql))),
    release: vi.fn(),
  };
  connectMock.mockResolvedValue(client);
  queryMock.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("SET processed_at = NOW()") && text.includes("claim_token")) {
      return { rows: [{ id: "evt" }] };
    }
    if (text.includes("SET claim_owner = NULL") && text.includes("claim_token")) {
      return { rows: [] };
    }
    return handler(text);
  });
  applySuppressionMock.mockResolvedValue(undefined);
  return client;
}

describe("resend webhook processor", () => {
  beforeEach(() => {
    queryMock.mockReset();
    connectMock.mockReset();
    applySuppressionMock.mockReset();
  });

  it("stops on duplicate event ids without reprocessing", async () => {
    setupClient((sql) => {
      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("INSERT INTO provider_events")) {
        return { rows: [] };
      }
      if (sql.includes("SET claim_owner")) {
        return { rows: [] }; // claim fails
      }
      if (sql.includes("SELECT processed_at")) {
        return { rows: [{ processed_at: "2026-01-01T00:00:00Z" }] };
      }
      return { rows: [] };
    });

    const result = await processResendWebhookEvent(
      "evt_dup",
      { type: "email.delivered", data: { email_id: "email_1", to: ["a@contoso.com"] } },
      "{}",
    );
    expect(result.duplicate).toBe(true);
    expect(result.processed).toBe(true);
    expect(applySuppressionMock).not.toHaveBeenCalled();
  });

  it("returns retryable when claim fails but event is still unprocessed", async () => {
    setupClient((sql) => {
      if (sql.includes("SET claim_owner")) return { rows: [] };
      if (sql.includes("SELECT processed_at")) return { rows: [{ processed_at: null }] };
      return { rows: [] };
    });

    const result = await processResendWebhookEvent(
      "evt_busy",
      { type: "email.delivered", data: { email_id: "email_1", to: ["a@contoso.com"] } },
      "{}",
    );
    expect(result.duplicate).toBe(false);
    expect(result.processed).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it("processes contact.updated unsubscribe into local suppression", async () => {
    setupClient((sql) => {
      if (sql.includes("SET claim_owner")) return { rows: [{ id: "evt_1" }] };
      if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
      return { rows: [] };
    });

    const result = await processResendWebhookEvent(
      "evt_1",
      { type: "contact.updated", data: { email: "user@contoso.com", unsubscribed: true } },
      '{"type":"contact.updated"}',
    );
    expect(result.duplicate).toBe(false);
    expect(applySuppressionMock).toHaveBeenCalledWith("user@contoso.com", "unsubscribe", "resend_webhook");
  });

  it("applies suppressions for bounce complaint suppressed paths", async () => {
    for (const [type, reason] of [
      ["email.bounced", "hard_bounce"],
      ["email.complained", "complaint"],
      ["email.suppressed", "provider_suppression"],
    ] as const) {
      applySuppressionMock.mockClear();
      setupClient((sql) => {
        if (sql.includes("SET claim_owner")) return { rows: [{ id: "evt" }] };
        return { rows: [] };
      });
      queryMock.mockResolvedValue({ rows: [{ id: "msg", status: "submitted" }] });

      await processResendWebhookEvent(
        `evt_${type}`,
        { type, data: { email_id: "email_x", to: ["bounce@contoso.com"], broadcast_id: "bcast_1" } },
        `{"type":"${type}"}`,
      );
      expect(applySuppressionMock).toHaveBeenCalledWith("bounce@contoso.com", reason, "resend_webhook");
    }
  });

  it("handles delayed sent and delivered without suppressing", async () => {
    for (const type of ["email.sent", "email.delivered", "email.delivery_delayed", "email.failed"]) {
      applySuppressionMock.mockClear();
      setupClient((sql) => {
        if (sql.includes("SET claim_owner")) return { rows: [{ id: "evt" }] };
        return { rows: [] };
      });
      queryMock.mockResolvedValue({ rows: [{ id: "msg", status: "submitted" }] });
      await processResendWebhookEvent(
        `evt_${type}`,
        { type, data: { email_id: "email_y", to: ["ok@contoso.com"] } },
        `{"type":"${type}"}`,
      );
      expect(applySuppressionMock).not.toHaveBeenCalled();
    }
  });
});
