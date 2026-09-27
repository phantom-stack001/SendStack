import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const applySuppressionMock = vi.fn();

vi.mock("../lib/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

vi.mock("../lib/suppressions", () => ({
  applySuppression: (...args: unknown[]) => applySuppressionMock(...args),
}));

import { processResendWebhookEvent } from "../lib/providers/webhook-processor";

describe("resend webhook processor", () => {
  beforeEach(() => {
    queryMock.mockReset();
    applySuppressionMock.mockReset();
    applySuppressionMock.mockResolvedValue(undefined);
  });

  it("stops on duplicate event ids without reprocessing", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // insert conflict / no return
      .mockResolvedValueOnce({ rows: [{ processed_at: "2026-01-01T00:00:00Z" }] }); // already processed
    const result = await processResendWebhookEvent(
      "evt_dup",
      { type: "email.delivered", data: { email_id: "email_1", to: ["a@contoso.com"] } },
      "{}",
    );
    expect(result.duplicate).toBe(true);
    expect(result.processed).toBe(false);
    expect(applySuppressionMock).not.toHaveBeenCalled();
  });

  it("processes contact.updated unsubscribe into local suppression", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "evt_1" }] }) // insert event
      .mockResolvedValueOnce({ rows: [] }) // resolve by provider id
      .mockResolvedValueOnce({ rows: [] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // mark processed
      ;
    // The processor has additional queries; provide permissive defaults after the first few.
    queryMock.mockResolvedValue({ rows: [] });

    const result = await processResendWebhookEvent(
      "evt_1",
      {
        type: "contact.updated",
        data: { email: "user@contoso.com", unsubscribed: true },
      },
      '{"type":"contact.updated"}',
    );
    expect(result.duplicate).toBe(false);
    expect(applySuppressionMock).toHaveBeenCalledWith("user@contoso.com", "unsubscribe", "resend_webhook");
  });

  it("applies suppressions for bounce complaint suppressed and failed paths", async () => {
    for (const [type, reason] of [
      ["email.bounced", "hard_bounce"],
      ["email.complained", "complaint"],
      ["email.suppressed", "provider_suppression"],
    ] as const) {
      queryMock.mockReset();
      applySuppressionMock.mockReset();
      applySuppressionMock.mockResolvedValue(undefined);
      queryMock.mockResolvedValue({ rows: [{ id: "evt" }, { id: "msg", status: "submitted" }, { campaign_id: "cam_1" }] });

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
      queryMock.mockReset();
      applySuppressionMock.mockReset();
      queryMock.mockResolvedValue({ rows: [{ id: "evt" }, { id: "msg", status: "submitted" }] });
      await processResendWebhookEvent(
        `evt_${type}`,
        { type, data: { email_id: "email_y", to: ["ok@contoso.com"] } },
        `{"type":"${type}"}`,
      );
      if (type === "email.failed") {
        // failed does not auto-suppress unless provider marks suppressed
        expect(applySuppressionMock).not.toHaveBeenCalled();
      } else {
        expect(applySuppressionMock).not.toHaveBeenCalled();
      }
    }
  });
});
