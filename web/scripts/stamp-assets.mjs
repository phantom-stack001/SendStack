import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "public/index.html");
const reset = process.argv.includes("--reset");
const version = reset
  ? "dev"
  : (
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.SOURCE_VERSION ||
      process.env.CF_PAGES_COMMIT_SHA ||
      `local-${Date.now().toString(36)}`
    ).slice(0, 12);

const html = readFileSync(indexPath, "utf8")
  .replace(/\/styles\.css(\?v=[^"']*)?/g, `/styles.css?v=${version}`)
  .replace(/\/app\.js(\?v=[^"']*)?/g, `/app.js?v=${version}`);

writeFileSync(indexPath, html);
console.log(`${reset ? "Reset" : "Stamped"} public assets with v=${version}`);
