export type PublicPageMeta = {
  title: string;
  description: string;
  canonicalPath: string;
};

export const publicPageMeta: Record<string, PublicPageMeta> = {
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
  "/login/": {
    title: "Sign in | SendStack",
    description: "Sign in to the SendStack workspace for CTN Slovakia.",
    canonicalPath: "/login/",
  },
  "/app/": {
    title: "Dashboard | SendStack",
    description: "SendStack dashboard overview for CTN Slovakia.",
    canonicalPath: "/app/",
  },
};

export function buildHeadTags(meta: PublicPageMeta) {
  const canonical = `https://ctn-sk.com${meta.canonicalPath}`;
  return [
    `<title>${meta.title}</title>`,
    `<meta name="description" content="${meta.description}" />`,
    `<link rel="canonical" href="${canonical}" />`,
  ].join("");
}
