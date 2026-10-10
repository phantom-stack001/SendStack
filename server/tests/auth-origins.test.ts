import { describe, expect, it } from "vitest";

import { authTrustedOrigins } from "../auth/origins.js";

describe("auth trusted origins", () => {
  it("accepts both the apex domain and www", () => {
    expect(authTrustedOrigins("https://ctn-sk.com")).toEqual([
      "https://ctn-sk.com",
      "https://www.ctn-sk.com",
    ]);
    expect(authTrustedOrigins("https://www.ctn-sk.com")).toEqual([
      "https://www.ctn-sk.com",
      "https://ctn-sk.com",
    ]);
  });

  it("leaves other origins unchanged", () => {
    expect(authTrustedOrigins("http://localhost:5173")).toEqual(["http://localhost:5173"]);
  });
});
