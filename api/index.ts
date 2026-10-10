import "../server/lib/startup-mark.js";

import { createVercelFetchHandler } from "../server/lib/vercel-handler.js";
import { getSendStackApp } from "../server/app.js";

export const config = {
  runtime: "nodejs",
};

export default createVercelFetchHandler(getSendStackApp());
