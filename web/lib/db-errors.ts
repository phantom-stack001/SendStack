/**
 * Client-facing translation of database failures.
 *
 * Raw driver text (for example `relation "daily_volume_counters" does not exist`)
 * discloses schema internals and is never returned to a caller. Schema-shaped
 * failures become a structured `database_migration_required` response so an
 * operator sees an actionable cause instead of a generic 500.
 */

export const DATABASE_MIGRATION_REQUIRED = "database_migration_required";
export const DATABASE_UNAVAILABLE = "database_unavailable";
export const INTERNAL_ERROR = "internal_error";

/** PostgreSQL SQLSTATEs that mean "the schema is not what this code expects". */
const SCHEMA_DRIFT_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42883", // undefined_function
  "42704", // undefined_object (missing type/constraint/index)
  "3F000", // invalid_schema_name
  "42P07", // duplicate_table (partially applied migration)
]);

/** SQLSTATEs that mean the database is unreachable or refusing work. */
const UNAVAILABLE_CODES = new Set([
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "55P03", // lock_not_available
  "57014", // query_canceled (statement timeout)
]);

const CONNECTION_ERRNO = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
]);

export type ClassifiedDbError = {
  status: number;
  code: string;
  message: string;
  /** True when the cause is schema drift rather than a transient fault. */
  migrationRequired: boolean;
  /** SQLSTATE or errno, for server-side logs only. Never returned to clients. */
  internalCode: string | null;
};

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return null;
}

export function isSchemaDriftError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && SCHEMA_DRIFT_CODES.has(code);
}

export function isDatabaseError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === null) return false;
  return (
    SCHEMA_DRIFT_CODES.has(code) ||
    UNAVAILABLE_CODES.has(code) ||
    CONNECTION_ERRNO.has(code) ||
    /^[0-9A-Z]{5}$/.test(code)
  );
}

/**
 * Map any thrown value to a safe client response.
 * The returned message is fixed text chosen by code — never driver output.
 */
export function classifyDbError(error: unknown): ClassifiedDbError {
  const code = errorCode(error);

  if (code !== null && SCHEMA_DRIFT_CODES.has(code)) {
    return {
      status: 503,
      code: DATABASE_MIGRATION_REQUIRED,
      message:
        "The database schema is behind this release. An operator must apply the pending migrations before this action can be used.",
      migrationRequired: true,
      internalCode: code,
    };
  }

  if (code !== null && (UNAVAILABLE_CODES.has(code) || CONNECTION_ERRNO.has(code))) {
    return {
      status: 503,
      code: DATABASE_UNAVAILABLE,
      message: "The database is temporarily unavailable. Try again shortly.",
      migrationRequired: false,
      internalCode: code,
    };
  }

  return {
    status: 500,
    code: INTERNAL_ERROR,
    message: "Unexpected server error.",
    migrationRequired: false,
    internalCode: code,
  };
}

/**
 * Message safe to return to a caller.
 *
 * Application-thrown validation errors are intentional user-facing text and are
 * passed through. Database failures are replaced with fixed text so SQLSTATE
 * details, relation names, and constraint names never reach a client.
 */
export function safeClientMessage(error: unknown, fallback: string): string {
  if (isDatabaseError(error)) {
    return classifyDbError(error).message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Redact anything that looks like a credential, connection string, or bearer
 * token before an error reaches a log sink.
 */
export function redactForLog(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://<redacted>")
    .replace(/\b(?:re|sk|pk|whsec|rk)_[A-Za-z0-9_-]{8,}/g, "<redacted-token>")
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer <redacted>")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<redacted-email>");
}

/** Log line for a failed request: keeps SQLSTATE, drops message internals. */
export function describeErrorForLog(error: unknown): string {
  const classified = classifyDbError(error);
  const name = error instanceof Error ? error.name : typeof error;
  const detail = error instanceof Error ? redactForLog(error.message) : "";
  return `code=${classified.code} sqlstate=${classified.internalCode ?? "none"} name=${name} detail="${detail.slice(0, 300)}"`;
}
