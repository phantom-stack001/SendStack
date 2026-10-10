import { handle } from "hono/vercel";

import { getSendStackApp } from "../server/app.js";

export const config = {
  runtime: "nodejs",
};

export default handle(getSendStackApp());
