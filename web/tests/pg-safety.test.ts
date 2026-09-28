import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENTED_TEST_DATABASE_URL,
  PgTestSafetyError,
  assertDisposableTestDatabase,
  databaseNameFromUrl,
  isDisposableTestDatabaseUrl,
  resolveTestDatabaseUrl,
  wipePublicSchema,
} from "./pg-test-utils";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("PostgreSQL test safety (no DATABASE_URL fallback)", () => {
  it("does not resolve a test URL from DATABASE_URL alone", () => {
    delete process.env.SENDSTACK_TEST_DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://prod:secret@db.example.com:5432/sendstack_prod";
    expect(resolveTestDatabaseUrl()).toBeNull();
    expect(() => resolveTestDatabaseUrl({ required: true })).toThrow(PgTestSafetyError);
  });

  it("refuses non-disposable SENDSTACK_TEST_DATABASE_URL names", () => {
    process.env.SENDSTACK_TEST_DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/sendstack_prod";
    expect(() => resolveTestDatabaseUrl()).toThrow(/non-disposable|Refusing/i);
    expect(isDisposableTestDatabaseUrl(process.env.SENDSTACK_TEST_DATABASE_URL)).toBe(false);
  });

  it("accepts deliberate _test database names and disposable marker", () => {
    expect(isDisposableTestDatabaseUrl(DOCUMENTED_TEST_DATABASE_URL)).toBe(true);
    expect(databaseNameFromUrl(DOCUMENTED_TEST_DATABASE_URL)).toBe("sendstack_test");
    expect(
      isDisposableTestDatabaseUrl("postgresql://u:p@127.0.0.1:5432/sendstack?sendstack_disposable=1"),
    ).toBe(true);
  });

  it("fail-closes destructive wipe when DATABASE_URL is not disposable", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/sendstack_prod";
    await expect(wipePublicSchema()).rejects.toThrow(PgTestSafetyError);
    expect(() => assertDisposableTestDatabase(process.env.DATABASE_URL!)).toThrow(PgTestSafetyError);
  });
});
