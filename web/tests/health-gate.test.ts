import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../lib/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import {
  assertDeliveryHealthAllowsSubmit,
  getDeliveryHealthSnapshot,
} from "../lib/delivery-health";

describe("delivery health 100% complaint/bounce gate", () => {
  beforeEach(() => {
    queryMock.mockReset();
    process.env.SENDSTACK_HEALTH_MIN_SAMPLE = "1";
    process.env.SENDSTACK_HEALTH_MAX_BOUNCE_RATE = "0.05";
    process.env.SENDSTACK_HEALTH_MAX_COMPLAINT_RATE = "0.001";
    process.env.SENDSTACK_HEALTH_MAX_UNSUBSCRIBE_RATE = "0.02";
    process.env.SENDSTACK_HEALTH_MAX_DELAY_RATE = "0.2";
    process.env.SENDSTACK_HEALTH_MAX_FAILURE_RATE = "0.05";
    delete process.env.SENDSTACK_EMERGENCY_STOP;
  });

  function mockHealthyBaseline() {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM messages") && sql.includes("FILTER")) {
        return {
          rows: [
            {
              submitted: "0",
              delivered: "0",
              delayed: "0",
              bounced: "0",
              failed: "0",
            },
          ],
        };
      }
      if (sql.includes("FROM suppressions") || sql.includes("reason = 'complaint'")) {
        return { rows: [{ complained: "10", unsubscribed: "0", suppressed: "0" }] };
      }
      return { rows: [{ count: "0" }] };
    });
  }

  it("marks unhealthy and launch-blocked when complaint rate is 100%", async () => {
    mockHealthyBaseline();
    const health = await getDeliveryHealthSnapshot();
    expect(health.complaint_rate).toBe(1);
    expect(health.healthy).toBe(false);
    expect(health.launch_blocked).toBe(true);
    expect(health.blocking_reasons.join(" ")).toMatch(/100%|Complaint/i);
  });

  it("marks unhealthy when bounce rate is 100%", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM messages") && sql.includes("FILTER")) {
        return {
          rows: [
            {
              submitted: "0",
              delivered: "0",
              delayed: "0",
              bounced: "8",
              failed: "0",
            },
          ],
        };
      }
      if (sql.includes("FROM suppressions") || sql.includes("reason = 'complaint'")) {
        return { rows: [{ complained: "0", unsubscribed: "0", suppressed: "0" }] };
      }
      return { rows: [{ count: "0" }] };
    });

    const health = await getDeliveryHealthSnapshot();
    expect(health.bounce_rate).toBe(1);
    expect(health.healthy).toBe(false);
    expect(health.launch_blocked).toBe(true);
  });

  it("submit health ignores only the current job, not unrelated submission_unknown", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM messages") && sql.includes("FILTER")) {
        return {
          rows: [{ submitted: "0", delivered: "5", delayed: "0", bounced: "0", failed: "0" }],
        };
      }
      if (sql.includes("FROM suppressions") || sql.includes("reason = 'complaint'")) {
        return { rows: [{ complained: "0", unsubscribed: "0", suppressed: "0" }] };
      }
      if (sql.includes("FROM launch_jobs")) {
        // Unrelated unresolved job still counted because ignore filter excludes only current id.
        return { rows: [{ count: "1" }] };
      }
      return { rows: [{ count: "0" }] };
    });

    await expect(
      assertDeliveryHealthAllowsSubmit({ jobId: "lj_current", campaignId: "cam_current" }),
    ).rejects.toThrow(/unresolved launch job/i);
  });

  it("does not query or block on provider webhook correlation under Spacemail SMTP", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM messages") && sql.includes("FILTER")) {
        return {
          rows: [{ submitted: "0", delivered: "5", delayed: "0", bounced: "0", failed: "0" }],
        };
      }
      if (sql.includes("FROM suppressions") || sql.includes("reason = 'complaint'")) {
        return { rows: [{ complained: "0", unsubscribed: "0", suppressed: "0" }] };
      }
      return { rows: [{ count: "0" }] };
    });

    const health = await getDeliveryHealthSnapshot();
    expect(health.launch_blocked).toBe(false);
    expect(health.webhook_correlation_complete).toBe(true);
    expect(health.webhook_events_received).toBe(0);
    expect(health.blocking_reasons.join(" ")).not.toMatch(/webhook/i);
    expect(
      queryMock.mock.calls.some(([sql]) => String(sql).includes("provider_events")),
    ).toBe(false);
  });
});
