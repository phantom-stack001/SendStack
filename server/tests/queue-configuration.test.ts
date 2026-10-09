import { describe, expect, it } from "vitest";

import { queueEnvSchema } from "../queue/configuration.js";

describe("queue configuration", () => {
  it("rejects disabling simulation-only mode", () => {
    const parsed = queueEnvSchema.safeParse({
      QUEUE_ENABLED: "true",
      QUEUE_SIMULATION_ONLY: "false",
      REDIS_URL: "redis://127.0.0.1:6379",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires REDIS_URL when queue is enabled", () => {
    const parsed = queueEnvSchema.safeParse({
      QUEUE_ENABLED: "true",
      QUEUE_SIMULATION_ONLY: "true",
    });
    expect(parsed.success).toBe(false);
  });
});
