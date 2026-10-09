import { describe, expect, it } from "vitest";

import { CAMPAIGN_STATUSES } from "../validation/campaigns.js";

describe("queue campaign statuses", () => {
  it("includes simulation lifecycle states", () => {
    expect(CAMPAIGN_STATUSES).toContain("queued");
    expect(CAMPAIGN_STATUSES).toContain("processing");
    expect(CAMPAIGN_STATUSES).toContain("paused");
    expect(CAMPAIGN_STATUSES).toContain("simulation_completed");
    expect(CAMPAIGN_STATUSES).toContain("simulation_failed");
  });
});
