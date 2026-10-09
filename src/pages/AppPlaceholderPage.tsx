import { Link } from "react-router-dom";

import { Atmosphere } from "@/components/layout/Atmosphere";
import { PageMeta } from "@/components/layout/PageMeta";

export function AppPlaceholderPage() {
  return (
    <div className="page legal-page">
      <PageMeta
        title="Workspace | CTN"
        description="CTN workspace sign-in."
        canonicalPath="/app/"
      />
      <Atmosphere />
      <main>
        <div className="shell">
          <Link className="legal-back" to="/">← Back to home</Link>
          <h1>Workspace</h1>
          <p className="lead">Sign in and account tools are planned for a future release.</p>
          <p className="workspace-note">
            This placeholder keeps the Sign in links from the public site working during Phase 1B.
            Authentication, registration, and the operator dashboard will be added in later phases.
          </p>
        </div>
      </main>
    </div>
  );
}
