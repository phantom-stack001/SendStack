import { describe, expect, it } from "vitest";

import { describeDatabaseTarget, describeRedisTarget } from "../lib/env-summary.js";

describe("environment summaries", () => {
  it("describes a database target without credentials", () => {
    const summary = describeDatabaseTarget(
      "postgresql://user:secret-pass@ep-example.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(summary).toBe(
      "set host=ep-example.eu-central-1.aws.neon.tech port=5432 db=neondb sslmode=require",
    );
    expect(summary).not.toContain("secret-pass");
    expect(summary).not.toContain("user");
  });

  it("describes an Upstash Redis target without credentials", () => {
    const summary = describeRedisTarget("rediss://default:topsecret@example.upstash.io:6379");
    expect(summary).toBe("set scheme=rediss host=example.upstash.io port=6379 tls=true");
    expect(summary).not.toContain("topsecret");
  });

  it("rejects non-redis urls without echoing them", () => {
    expect(describeRedisTarget("https://user:secret@example.upstash.io")).toBe("invalid");
  });
});
