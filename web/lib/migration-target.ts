import { createHash } from "node:crypto";

export type MigrationTargetIdentity = {
  fingerprint: string;
  host: string;
  port: string;
  database: string;
  local: boolean;
};

/**
 * Stable non-secret fingerprint of a migration target.
 * Uses the normalized server, port, and database name — not current_database() alone,
 * so two hosts that share a database name do not collide.
 */
export function migrationTargetIdentity(
  connectionString: string,
  currentDatabase: string,
): MigrationTargetIdentity {
  const url = new URL(connectionString);
  const host = url.hostname.replace(/-pooler(?=\.)/i, "").toLowerCase();
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] ?? "");
  if (!host || !database) {
    throw new Error("DATABASE_URL is missing a host or database name.");
  }
  if (database !== currentDatabase) {
    throw new Error("DATABASE_URL database name does not match current_database().");
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const fingerprint = createHash("sha256")
    .update(`${host}|${port}|${database}`)
    .digest("hex")
    .slice(0, 10);
  return { fingerprint, host, port, database, local };
}
