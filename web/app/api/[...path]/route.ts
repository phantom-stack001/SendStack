import { handleApi } from "@/lib/api-router";

type Params = { params: Promise<{ path: string[] }> };

async function dispatch(request: Request, context: Params) {
  try {
    const { path } = await context.params;
    return await handleApi(request, path ?? []);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("[api]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
