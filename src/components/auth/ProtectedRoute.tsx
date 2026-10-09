import { Navigate, useLocation } from "react-router-dom";

import { AuthLoadingScreen } from "@/components/auth/AuthLoadingScreen";
import { authClient } from "@/lib/auth-client";

type ProtectedRouteProps = {
  children: React.ReactNode;
};

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { pathname } = useLocation();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <AuthLoadingScreen />;
  }

  if (!session?.user) {
    const redirect = encodeURIComponent(pathname);
    return <Navigate to={`/login/?redirect=${redirect}`} replace />;
  }

  if (!session.user.emailVerified) {
    return <Navigate to="/verify-email/" replace state={{ email: session.user.email }} />;
  }

  return children;
}
