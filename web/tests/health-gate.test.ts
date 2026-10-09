import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../lib/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import {
  assertDeliveryHealthAllowsSubmit,
  getDeliveryHealthSnapshot,
} from "../lib/delivery-health";

describe("delivery health operational gates (Spacemail SMTP)", () => {
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

  it("records high complaint rates as informational issues without blocking launch", async () => {
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

    const health = await getDeliveryHealthSnapshot();
    expect(health.complaint_rate).toBe(1);
    expect(health.healthy).toBe(false);
    expect(health.launch_blocked).toBe(false);
    expect(health.issues.join(" ")).toMatch(/Complaint/i);
    expect(health.blocking_reasons).toEqual([]);
  });

  it("records high bounce rates as informational issues without blocking launch", async () => {
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
    expect(health.launch_blocked).toBe(false);
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
        return { rows: [{ count: "1" }] };
      }
      return { rows: [{ count: "0" }] };
    });

    await expect(
      assertDeliveryHealthAllowsSubmit({ jobId: "lj_current", campaignId: "cam_current" }),
    ).rejects.toThrow(/unresolved launch job/i);
  });

  it("blocks launch when emergency stop is enabled", async () => {
    process.env.SENDSTACK_EMERGENCY_STOP = "true";
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
    expect(health.launch_blocked).toBe(true);
    expect(health.blocking_reasons.join(" ")).toMatch(/EMERGENCY_STOP/i);
  });

  it("does not query provider_events under Spacemail SMTP", async () => {
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
