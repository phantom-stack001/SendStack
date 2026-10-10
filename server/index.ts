import { serve } from "@hono/node-server";

import { createSendStackApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { app } = createSendStackApp(env, { seedAccess: true });

const server = serve(
  {
    fetch: app.fetch,
    hostname: "0.0.0.0",
    port: env.PORT,
  },
  (info) => {
    console.info(`SendStack API listening on port ${info.port}`);
  },
);

function shutdown(signal: string) {
  console.info(`[api] shutting down (${signal})`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
