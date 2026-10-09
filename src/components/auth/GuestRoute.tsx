import { Navigate } from "react-router-dom";

import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { authClient } from "@/lib/auth-client";

type GuestRouteProps = {
  children: React.ReactNode;
};

export function GuestRoute({ children }: GuestRouteProps) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <AuthLoadingScreen label="Loading…" />;
  }

  if (session?.user?.emailVerified) {
    return <Navigate to="/app/" replace />;
  }

  return children;
}
