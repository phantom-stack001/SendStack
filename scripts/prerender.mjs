import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "../dist");
const templatePath = path.join(distDir, "index.html");

const { render } = await import(path.join(distDir, "server/entry-server.js"));

const routes = ["/", "/privacy/", "/terms/", "/app/"];
const template = fs.readFileSync(templatePath, "utf8");

const headByRoute = {
  "/": {
    title: "CTN | Communication & Technology Network",
    description:
      "CTN helps organizations deliver clear, reliable digital communications with practical tools, careful operations, and accountable support.",
    canonicalPath: "/",
  },
  "/privacy/": {
    title: "Privacy Policy | CTN",
    description: "How this service collects, uses, and protects information.",
    canonicalPath: "/privacy/",
  },
  "/terms/": {
    title: "Terms of Service | CTN",
    description: "Terms governing use of this website and related services.",
    canonicalPath: "/terms/",
  },
  "/app/": {
    title: "Workspace | CTN",
    description: "CTN workspace sign-in.",
    canonicalPath: "/app/",
  },
};

function buildHeadTags(meta) {
  const canonical = `https://ctn-sk.com${meta.canonicalPath}`;
  return [
    `<title>${meta.title}</title>`,
    `<meta name="description" content="${meta.description}" />`,
    `<link rel="canonical" href="${canonical}" />`,
  ].join("");
}

for (const url of routes) {
  const { appHtml, headHtml } = await render(url);
  const metaHead = buildHeadTags(headByRoute[url]);
  const mergedHead = headHtml ? `${metaHead}${headHtml}` : metaHead;

  const html = template
    .replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`)
    .replace("</head>", `    ${mergedHead}\n  </head>`);

  if (url === "/") {
    fs.writeFileSync(templatePath, html);
    continue;
  }

  const outDir = path.join(distDir, url.slice(1));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "index.html"), html);
}

console.log(`Prerendered ${routes.length} public routes.`);
