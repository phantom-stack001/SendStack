import { handleApi } from "@/lib/api-router";
import { classifyDbError, describeErrorForLog } from "@/lib/db-errors";

type Params = { params: Promise<{ path: string[] }> };

/**
 * Single error boundary for the API surface.
 * Driver and runtime messages are never returned to the caller: a raw
 * PostgreSQL message discloses schema internals, and schema-shaped failures are
 * reported as a structured `database_migration_required` instead of a generic 500.
 */
async function dispatch(request: Request, context: Params) {
  try {
    const { path } = await context.params;
    return await handleApi(request, path ?? []);
  } catch (error) {
    const classified = classifyDbError(error);
    console.error(`[api] ${request.method} failed: ${describeErrorForLog(error)}`);
    return Response.json(
      { error: classified.message, code: classified.code },
      { status: classified.status },
    );
  }
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
