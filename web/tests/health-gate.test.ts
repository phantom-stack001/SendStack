import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../lib/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { getDeliveryHealthSnapshot } from "../lib/delivery-health";

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

  it("marks unhealthy and launch-blocked when complaint rate is 100%", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM messages")) {
        return {
          rows: [
            {
              submitted: "0",
              delivered: "0",
              delayed: "0",
              bounced: "0",
              complained: "10",
              suppressed: "0",
              unsubscribed: "0",
              failed: "0",
            },
          ],
        };
      }
      if (sql.includes("COUNT(*)::int AS received")) {
        return { rows: [{ received: "0", processed: "0" }] };
      }
      return { rows: [{ count: "0" }] };
    });

    const health = await getDeliveryHealthSnapshot();
    expect(health.complaint_rate).toBe(1);
    expect(health.healthy).toBe(false);
    expect(health.launch_blocked).toBe(true);
    expect(health.blocking_reasons.join(" ")).toMatch(/100%/i);
  });

  it("marks unhealthy when bounce rate is 100%", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM messages")) {
        return {
          rows: [
            {
              submitted: "0",
              delivered: "0",
              delayed: "0",
              bounced: "8",
              complained: "0",
              suppressed: "0",
              unsubscribed: "0",
              failed: "0",
            },
          ],
        };
      }
      if (sql.includes("COUNT(*)::int AS received")) {
        return { rows: [{ received: "0", processed: "0" }] };
      }
      return { rows: [{ count: "0" }] };
    });

    const health = await getDeliveryHealthSnapshot();
    expect(health.bounce_rate).toBe(1);
    expect(health.healthy).toBe(false);
    expect(health.launch_blocked).toBe(true);
  });
});
