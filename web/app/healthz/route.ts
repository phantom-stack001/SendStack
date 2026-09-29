import { config } from "@/lib/config";
import { DATABASE_MIGRATION_REQUIRED, DATABASE_UNAVAILABLE } from "@/lib/db-errors";
import { json } from "@/lib/http";
import { inspectSchema } from "@/lib/schema-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness plus schema readiness. A deploy whose schema is behind the code must
 * report unhealthy here rather than appear "ok" and fail per request.
 * Never returns driver text: only the names of missing schema objects.
 */
export async function GET() {
  if (!config.databaseUrl) {
    return json(503, {
      status: "unhealthy",
      mode: config.deliveryMode,
      runtime: "vercel",
      code: DATABASE_UNAVAILABLE,
      database: "not_configured",
    });
  }

  const schema = await inspectSchema();

  if (!schema.reachable) {
    return json(503, {
      status: "unhealthy",
      mode: config.deliveryMode,
      runtime: "vercel",
      code: DATABASE_UNAVAILABLE,
      database: "unreachable",
    });
  }

  if (!schema.ok) {
    return json(503, {
      status: "degraded",
      mode: config.deliveryMode,
      runtime: "vercel",
      code: DATABASE_MIGRATION_REQUIRED,
      database: "migration_required",
      schema: {
        missing_migrations: schema.missing_migrations,
        missing_tables: schema.missing_tables,
        missing_columns: schema.missing_columns,
        missing_indexes: schema.missing_indexes,
        missing_constraints: schema.missing_constraints,
        unknown_migrations: schema.unknown_migrations,
        checksum_drift: schema.checksum_drift,
      },
    });
  }

  return json(200, {
    status: "ok",
    mode: config.deliveryMode,
    runtime: "vercel",
    database: "ready",
    schema_migrations_applied: schema.applied_migrations.length,
  });
}
