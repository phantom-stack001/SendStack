import { Link } from "react-router-dom";

import { Atmosphere } from "@/components/layout/Atmosphere";
import { PageMeta } from "@/components/layout/PageMeta";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <div className="page legal-page">
      <PageMeta
        title="Page not found | CTN"
        description="The requested page could not be found."
        canonicalPath="/404/"
      />
      <Atmosphere />
      <main>
        <div className="shell">
          <h1>Page not found</h1>
          <p className="lead">The page you requested does not exist or has moved.</p>
          <Button asChild className="mt-4">
            <Link to="/">Back to home</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
