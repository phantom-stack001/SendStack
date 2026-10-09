import { describe, expect, it } from "vitest";

import { getCell, parseCsvText } from "../lib/csv-parse.js";

describe("csv parse", () => {
  it("parses quoted commas", () => {
    const csv = `email,first\n"a@example.com","Tom, Jr"`;
    const parsed = parseCsvText(csv, 100);
    expect(parsed.headers).toEqual(["email", "first"]);
    expect(getCell(parsed.rows[0], parsed.headers, "first")).toBe("Tom, Jr");
  });
});
