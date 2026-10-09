import { Helmet } from "react-helmet-async";

import type { PublicPageMeta } from "@/lib/page-meta";

export function PageMeta({ title, description, canonicalPath }: PublicPageMeta) {
  const canonical = `https://ctn-sk.com${canonicalPath}`;

  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />
    </Helmet>
  );
}
