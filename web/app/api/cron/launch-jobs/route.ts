import { DATABASE_MIGRATION_REQUIRED, DATABASE_UNAVAILABLE } from "@/lib/db-errors";
import { makeId } from "@/lib/ids";
import { runLaunchWorkerTick } from "@/lib/launch-jobs";
import { liveSendAllowed } from "@/lib/live-send";
import { inspectSchema, summarizeSchemaReport } from "@/lib/schema-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * External scheduler endpoint (GET only).
 * Authenticate with Authorization: Bearer ${CRON_SECRET}.
 * Does not schedule itself — operators must hit this every minute.
 */
export async function GET(request: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not configured. Launch-job cron is unavailable." },
      { status: 503 },
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (auth !== expected) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const schema = await inspectSchema();
  if (!schema.reachable || !schema.ok) {
    return Response.json(
      {
        error: schema.reachable ? summarizeSchemaReport(schema) : "The database could not be inspected.",
        code: schema.reachable ? DATABASE_MIGRATION_REQUIRED : DATABASE_UNAVAILABLE,
      },
      { status: 503 },
    );
  }

  const workerId = makeId("cron");
  const result = await runLaunchWorkerTick({
    workerId,
    timeBudgetMs: 20_000,
    live: liveSendAllowed(),
  });

  return Response.json({
    ok: true,
    ...result,
  });
}
