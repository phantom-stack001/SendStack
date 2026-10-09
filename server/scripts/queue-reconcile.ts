import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { isQueueEnabled } from "../queue/connection.js";
import { reconcileOrphanedPendingJobs } from "../services/queue-reconciliation.js";

const env = loadEnv();
const { db, client } = createDb(env);

async function main() {
  if (!isQueueEnabled()) {
    console.error("Queue is disabled. Set QUEUE_ENABLED=true and REDIS_URL.");
    process.exit(1);
  }
  const result = await reconcileOrphanedPendingJobs(db);
  console.info("Reconciliation complete", result);
  await client.end({ timeout: 5 });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
