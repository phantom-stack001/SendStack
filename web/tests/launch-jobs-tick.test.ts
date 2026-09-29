import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readTickConfig, runLaunchJobsTick, sanitizeTickResult } from "../scripts/launch-jobs-tick";

describe("Hobby launch-job tick", () => {
  it("reads only the canonical origin and secret", () => {
    const config = readTickConfig(
      'SENDSTACK_PUBLIC_URL="https://www.example.com"\nCRON_SECRET=not-a-real-secret\n',
    );
    expect(config.origin).toBe("https://www.example.com");
    expect(config.secret).toBe("not-a-real-secret");
  });

  it("rejects a non-https origin and a missing secret", () => {
    expect(() => readTickConfig("SENDSTACK_PUBLIC_URL=http://www.example.com\nCRON_SECRET=x\n")).toThrow(
      /https/,
    );
    expect(() => readTickConfig("SENDSTACK_PUBLIC_URL=https://www.example.com\n")).toThrow(/CRON_SECRET/);
  });

  it("refuses redirects and non-2xx responses", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 308, headers: { location: "https://elsewhere.example" } }));
    await expect(
      runLaunchJobsTick({ origin: "https://www.example.com", secret: "secret" }, redirect as typeof fetch),
    ).rejects.toThrow(/redirect/i);
    const missing = vi.fn(async () => Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 }));
    await expect(
      runLaunchJobsTick({ origin: "https://www.example.com", secret: "secret" }, missing as typeof fetch),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("returns a bounded result and drops unexpected fields", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        ok: true,
        claimed: false,
        status: "paused_emergency_stop",
        chunks: 0,
        secret: "must-not-leak",
        error: "must-not-leak",
      }),
    );
    const result = await runLaunchJobsTick(
      { origin: "https://www.example.com", secret: "secret" },
      fetchImpl as typeof fetch,
    );
    expect(result).toEqual({ ok: true, claimed: false, status: "paused_emergency_stop", chunks: 0 });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("has no scheduler, loop, or retry daemon", () => {
    const source = readFileSync(new URL("../scripts/launch-jobs-tick.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/setInterval|setTimeout|while\s*\(|for\s*\(\s*;/);
    expect(sanitizeTickResult({ ok: true, password: "nope" })).toEqual({ ok: true });
  });
});
