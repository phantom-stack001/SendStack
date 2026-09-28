import { makeId } from "@/lib/ids";
import { runLaunchWorkerTick } from "@/lib/launch-jobs";
import { liveSendAllowed } from "@/lib/providers/resend";

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
