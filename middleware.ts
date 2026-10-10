import { vercelApiMiddleware } from "./server/lib/vercel-middleware.js";

export const config = {
  matcher: ["/api/:path*"],
};

export default function middleware(request: Request) {
  return vercelApiMiddleware(request);
}
