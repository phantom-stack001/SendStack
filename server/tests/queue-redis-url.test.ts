import { describe, expect, it } from "vitest";

import { classifyRedisEndpoint, maskRedisUrl, summarizeRedisUrl } from "../queue/redis-url.js";
import { buildBullmqRedisOptions } from "../queue/redis-connection-options.js";
import {
  campaignDispatchBullmqJobId,
  emailProcessingBullmqJobId,
} from "../queue/job-types.js";

describe("redis URL helpers", () => {
  it("accepts redis and rediss schemes", () => {
    expect(summarizeRedisUrl("redis://127.0.0.1:6379").tls).toBe(false);
    expect(summarizeRedisUrl("rediss://default:secret@example.upstash.io:6379").tls).toBe(true);
  });

  it("classifies local and Upstash endpoints without using the REST API", () => {
    expect(classifyRedisEndpoint("redis://127.0.0.1:6379")).toBe("local");
    expect(classifyRedisEndpoint("rediss://default:secret@example.upstash.io:6379")).toBe("upstash");
    expect(() => classifyRedisEndpoint("https://example.upstash.io")).toThrow(/Redis protocol/);
  });

  it("rejects non-redis protocols", () => {
    expect(() => summarizeRedisUrl("https://example.com")).toThrow(/Redis protocol/);
  });

  it("masks credentials in URLs", () => {
    expect(maskRedisUrl("rediss://default:topsecret@host.example:6379")).toBe(
      "rediss://default:***@host.example:6379",
    );
  });

  it("enables TLS options for rediss without disabling certificate validation", () => {
    const options = buildBullmqRedisOptions("rediss://127.0.0.1:6379");
    expect(options.tls).toEqual({});
    expect(options).not.toHaveProperty("rejectUnauthorized", false);
    expect(options.maxRetriesPerRequest).toBeNull();
  });
});

describe("bullmq job id helpers", () => {
  it("does not use colon separators", () => {
    const deliveryJobId = "dj_01abc";
    const campaignId = "camp_01xyz";
    expect(emailProcessingBullmqJobId(deliveryJobId)).toBe(`email-${deliveryJobId}`);
    expect(campaignDispatchBullmqJobId(campaignId, 2)).toBe(`dispatch-${campaignId}-2`);
    expect(emailProcessingBullmqJobId(deliveryJobId)).not.toContain(":");
    expect(campaignDispatchBullmqJobId(campaignId, 2)).not.toContain(":");
  });
});
